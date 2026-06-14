"""
ResponseEvaluationNode — Score how well the final response answers the user query.

Takes the original user query and the final response (SQL results + summary),
asks the LLM to evaluate precision and relevance, and returns a structured
score with justification.

Pipeline position (after SQLExecutionNode):
    SQLGenerationNode >> SQLExecutionNode >> ResponseEvaluationNode

Shared-state contract:
──────────────────────────────────────────────
  Required inputs:
      query              (str)  — original natural-language question
      sql_results        (list[dict]) — execution results from SQLExecutionNode

  Optional inputs:
      sql_results_summary (str)  — human-readable summary (auto-generated if absent)
      sql_queries         (list[dict]) — the SQL that produced the results

  Outputs:
      evaluation          (dict) — structured evaluation:
          precision_score   (float)  0.0–1.0
          verdict           (str)    "excellent" | "good" | "partial" | "poor" | "off_topic"
          justification     (str)    1–3 sentence explanation
          missing           (list[str])  aspects of the question not covered
          suggestions       (list[str])  recommended follow-up queries
"""

from __future__ import annotations

import yaml
from typing import Any, Dict, List, Optional

from nodes.base_node import BaseNode
from nodes.thinking.sql_generation_node import _format_sql_results
from llm.llm_factory import get_llm
from config import get_settings
from monitoring.logger import get_logger

logger = get_logger(__name__)

_VERDICTS = ("excellent", "good", "partial", "poor", "off_topic")

from prompt_loader import load_template

_BASE_SYSTEM_PROMPT = load_template("thinking", "response_evaluation")


def _build_evaluation_system_prompt(skills_context: str = "") -> str:
    if not skills_context:
        return _BASE_SYSTEM_PROMPT

    return (
        _BASE_SYSTEM_PROMPT
        + "\n\n## Expertise métier (skills chargés)\n\n"
        + skills_context
        + "\n\nUtilise ces connaissances pour évaluer si les requêtes appliquent les bonnes "
        "formules KPI, les bons benchmarks et les méthodologies reconnues (OMT, WTTC, OCDE)."
    )


def _build_evaluation_prompt(
    query: str,
    sql_queries: List[Dict[str, Any]],
    results_text: str,
) -> str:
    sql_section = ""
    if sql_queries:
        snippets = []
        for i, q in enumerate(sql_queries):
            label = q.get("label", f"Query {i + 1}")
            sql = q.get("sql", "").strip()
            snippets.append(f"### {label}\n```sql\n{sql}\n```")
        sql_section = "\n\n".join(snippets)

    parts = [f"## User question\n{query}"]
    if sql_section:
        parts.append(f"\n## Generated SQL queries\n{sql_section}")
    parts.append(f"\n## Query results\n{results_text}")
    return "\n".join(parts)


def _parse_evaluation(raw: str) -> Dict[str, Any]:
    """Parse the LLM YAML evaluation response."""
    yaml_str = raw
    if "```yaml" in raw:
        yaml_str = raw.split("```yaml", 1)[1].split("```", 1)[0]
    elif "```" in raw:
        yaml_str = raw.split("```", 1)[1].split("```", 1)[0]

    parsed = yaml.safe_load(yaml_str)
    if not isinstance(parsed, dict):
        raise ValueError("Evaluation response is not a YAML mapping")

    score = float(parsed.get("precision_score", 0))
    score = max(0.0, min(1.0, score))

    verdict = str(parsed.get("verdict", "")).lower().strip()
    if verdict not in _VERDICTS:
        if score >= 0.9:
            verdict = "excellent"
        elif score >= 0.7:
            verdict = "good"
        elif score >= 0.4:
            verdict = "partial"
        elif score >= 0.1:
            verdict = "poor"
        else:
            verdict = "off_topic"

    return {
        "precision_score": round(score, 2),
        "verdict": verdict,
        "justification": str(parsed.get("justification", "")),
        "missing": parsed.get("missing") or [],
        "suggestions": parsed.get("suggestions") or [],
    }


class ResponseEvaluationNode(BaseNode):
    """Evaluate how well SQL results answer the user's question.

    Parameters:
        max_retries: LLM call retries on parse failure.
        threshold:   Minimum precision_score to return ``"default"`` (pass).
                     Below this the node returns ``"insufficient"``.
    """

    def __init__(
        self,
        name: Optional[str] = None,
        max_retries: int = 2,
        threshold: float = 0.5,
    ):
        super().__init__(name or "ResponseEvaluation")
        self._max_retries = max_retries
        self._threshold = threshold

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)

        query = shared.get("query") or shared.get("user_query") or ""
        if not query:
            raise ValueError("ResponseEvaluationNode requires 'query' in shared state")

        sql_results = shared.get("sql_results")
        if not sql_results:
            raise ValueError("ResponseEvaluationNode requires 'sql_results' in shared state")

        results_text = (
            shared.get("sql_results_summary", "")
            + "\n\n"
            + _format_sql_results(sql_results)
        ).strip()

        sql_queries = shared.get("sql_queries", [])

        return {
            "query": query,
            "sql_queries": sql_queries,
            "results_text": results_text,
            "skills_context": shared.get("skills_context", ""),
        }

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        sync_client, _ = get_llm()
        model = get_settings().llm.model

        user_prompt = _build_evaluation_prompt(
            query=prep_result["query"],
            sql_queries=prep_result["sql_queries"],
            results_text=prep_result["results_text"],
        )

        system_prompt = _build_evaluation_system_prompt(prep_result.get("skills_context", ""))
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]

        last_error: Optional[str] = None
        raw_response = ""

        for attempt in range(self._max_retries):
            if last_error:
                messages.append({
                    "role": "user",
                    "content": (
                        f"Your previous response could not be parsed:\n{last_error}\n\n"
                        "Please respond again with valid YAML only."
                    ),
                })

            try:
                response = sync_client.chat.completions.create(
                    model=model,
                    messages=messages,
                )
                raw_response = response.choices[0].message.content or ""
                evaluation = _parse_evaluation(raw_response)

                self.logger.info(
                    "Evaluation: score=%.2f verdict=%s (attempt %d/%d)",
                    evaluation["precision_score"],
                    evaluation["verdict"],
                    attempt + 1,
                    self._max_retries,
                )
                return evaluation

            except Exception as exc:
                last_error = str(exc)
                self.logger.warning(
                    "Evaluation attempt %d/%d failed: %s",
                    attempt + 1, self._max_retries, last_error,
                )

        self.logger.error("Evaluation failed after %d attempts", self._max_retries)
        return {
            "precision_score": 0.0,
            "verdict": "poor",
            "justification": f"Evaluation could not be completed: {last_error}",
            "missing": [],
            "suggestions": [],
            "error": last_error,
        }

    def post(
        self,
        shared: Dict[str, Any],
        prep_result: Dict[str, Any],
        exec_result: Dict[str, Any],
    ) -> str:
        shared["evaluation"] = exec_result

        score = exec_result.get("precision_score", 0.0)

        if score >= self._threshold:
            self.log_exit("default")
            return "default"

        self.log_exit("insufficient")
        return "insufficient"


if __name__ == "__main__":
    from nodes.thinking.sql_generation_node import SQLGenerationNode
    from nodes.thinking.sql_execution_node import SQLExecutionNode

    # Step 1: Generate
    gen = SQLGenerationNode(use_memory=False)
    shared: Dict[str, Any] = {
        "query": "Quelles destinations enregistrent la croissance la plus forte en nuitées sur les 5 dernières années ?",
    }
    gen.run(shared)

    # Step 2: Execute
    exe = SQLExecutionNode()
    exe.run(shared)

    print("=== Results ===")
    print(shared.get("sql_results_summary", ""))
    print()

    # Step 3: Evaluate
    evaluator = ResponseEvaluationNode(threshold=0.5)
    evaluator.run(shared)

    ev = shared["evaluation"]
    print("=== Evaluation ===")
    print(f"  Score:         {ev['precision_score']}")
    print(f"  Verdict:       {ev['verdict']}")
    print(f"  Justification: {ev['justification']}")
    if ev.get("missing"):
        print(f"  Missing:       {ev['missing']}")
    if ev.get("suggestions"):
        print(f"  Suggestions:   {ev['suggestions']}")
