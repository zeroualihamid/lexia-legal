"""
ChartSQLNode — Analyze SQL queries/results and generate a chart-ready SQL query if meaningful.

Takes the list of SQL queries (and optionally their results) from the thinking flow,
uses the LLM to determine if the response can be meaningfully represented as a chart.
If yes, generates a single DuckDB SQL query optimized for visualization (e.g. bar, line, pie).

Shared-state contract:
──────────────────────────────────────────────
  Required inputs:
      sql_queries        (list[dict]) — query descriptors with label, sql

  Optional inputs:
      sql_results        (list[dict]) — execution results (columns, rows, label)
      query               (str)      — original user question (for context)
      parquet_cache_dir   (str)      — override parquet directory

  Outputs:
      chart_sql_query     (str|None) — SQL query for chart, or None if not chartable
      chart_type          (str|None) — "bar" | "line" | "pie" | "area" | None
      chart_label         (str|None) — human-readable chart title
      chart_reason        (str|None) — why chartable or not (for debugging)
"""

from __future__ import annotations

import re
import yaml
from pathlib import Path
from typing import Any, Dict, List, Optional

import duckdb

from nodes.base_node import BaseNode
from llm.llm_factory import create_client_for_task
from config import get_settings
from config.settings import settings as pydantic_settings
from monitoring.logger import get_logger

logger = get_logger(__name__)

from prompt_loader import load_template

_BASE_CHART_SYSTEM_PROMPT = load_template("graphics", "chart_sql")


def _build_chart_system_prompt(skills_context: str = "") -> str:
    if not skills_context:
        return _BASE_CHART_SYSTEM_PROMPT

    return (
        _BASE_CHART_SYSTEM_PROMPT
        + "\n## Expertise métier (skills chargés)\n\n"
        + skills_context
        + "\n\nUtilise ces connaissances métier pour choisir le type de graphique le plus "
        "pertinent et formuler des labels compréhensibles par un décideur touristique."
    )


def _format_queries_and_results(
    sql_queries: List[Dict[str, Any]],
    sql_results: List[Dict[str, Any]],
) -> str:
    """Format SQL queries and their results for the LLM."""
    parts: List[str] = []
    for i, q in enumerate(sql_queries):
        label = q.get("label", f"Requête {i+1}")
        sql = q.get("sql", "").strip()
        parts.append(f"### {label}\n```sql\n{sql}\n```")

        # Attach results if available
        res = next((r for r in sql_results if r.get("label") == label), None)
        if res and not res.get("error"):
            cols = res.get("columns", [])
            rows = res.get("rows", [])[:15]
            if cols and rows:
                header = "| " + " | ".join(str(c) for c in cols) + " |"
                sep = "| " + " | ".join("---" for _ in cols) + " |"
                body = [
                    "| " + " | ".join(str(v) if v is not None else "" for v in row) + " |"
                    for row in rows
                ]
                parts.append("\nRésultats :\n" + "\n".join([header, sep, *body]))
                if res.get("row_count", 0) > 15:
                    parts.append(f"\n... ({res['row_count']} lignes au total)")
    return "\n\n".join(parts)


def _fix_parquet_paths(sql: str, parquet_dir: Path) -> str:
    """Ensure read_parquet() calls use the full path including the parquet directory.

    LLMs sometimes emit ``read_parquet('file.parquet')`` instead of the
    expected ``read_parquet('data/parquet/file.parquet')``.  This rewrites
    any bare filename to use *parquet_dir*.
    """
    prefix = str(parquet_dir).rstrip("/") + "/"

    def _replacer(m: re.Match) -> str:
        quote = m.group(1)
        path = m.group(2)
        if path.startswith(prefix) or path.startswith("data/"):
            return f"read_parquet({quote}{path}{quote})"
        bare = path.rsplit("/", 1)[-1]
        return f"read_parquet({quote}{prefix}{bare}{quote})"

    return re.sub(r"read_parquet\((['\"])([^'\"]+)\1\)", _replacer, sql)


def _validate_sql(sql: str) -> bool:
    """Check that the SQL is syntactically valid DuckDB."""
    try:
        conn = duckdb.connect(":memory:")
        try:
            conn.execute(f"EXPLAIN {sql}")
        except (duckdb.BinderException, duckdb.CatalogException):
            pass
        finally:
            conn.close()
        return True
    except duckdb.ParserException:
        return False


class ChartSQLNode(BaseNode):
    """Analyze SQL queries/results and generate a chart-ready SQL query if meaningful."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "ChartSQL")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)

        sql_queries = shared.get("sql_queries")
        if not sql_queries:
            raise ValueError("ChartSQLNode requires 'sql_queries' in shared state")

        sql_results = shared.get("sql_results", [])
        query = shared.get("query", "")
        parquet_dir = Path(
            shared.get("parquet_cache_dir")
            or str(pydantic_settings.parquet_cache_dir)
        )

        return {
            "sql_queries": sql_queries,
            "sql_results": sql_results,
            "query": query,
            "skills_context": shared.get("skills_context", ""),
            "parquet_dir": parquet_dir,
        }

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        sql_queries = prep_result["sql_queries"]
        sql_results = prep_result["sql_results"]
        query = prep_result["query"]
        parquet_dir = prep_result["parquet_dir"]

        formatted = _format_queries_and_results(sql_queries, sql_results)

        user_content = f"""## Question utilisateur
{query or "(non fournie)"}

## Requêtes SQL et résultats

{formatted}

---

Détermine si ces données peuvent être représentées par un graphique pertinent.
Si oui, génère une requête SQL DuckDB optimisée pour la visualisation (même schéma, mêmes fichiers parquet).
Utilise read_parquet() pour les chemins. Limite à 20–30 lignes si nécessaire pour la lisibilité."""

        llm = create_client_for_task("chart")

        chart_prompt = _build_chart_system_prompt(prep_result.get("skills_context", ""))
        prompt = f"{chart_prompt}\n\n{user_content}"
        llm_response = llm.generate(prompt)
        if isinstance(llm_response, str):
            raw = llm_response
        else:
            raw = getattr(llm_response, "content", None) or str(llm_response)

        try:
            yaml_str = raw
            if "```yaml" in raw:
                yaml_str = raw.split("```yaml", 1)[1].split("```", 1)[0].strip()
            elif "```" in raw:
                yaml_str = raw.split("```", 1)[1].split("```", 1)[0].strip()

            parsed = yaml.safe_load(yaml_str)
            if not isinstance(parsed, dict):
                return {"chartable": False, "reason": "Réponse LLM invalide", "raw": raw}

            chartable = bool(parsed.get("chartable", False))
            reason = str(parsed.get("reason", ""))

            if not chartable:
                return {
                    "chartable": False,
                    "reason": reason,
                    "chart_sql_query": None,
                    "chart_type": None,
                    "chart_label": None,
                }

            chart_sql = (parsed.get("chart_sql") or "").strip()
            chart_type = parsed.get("chart_type") or "bar"
            chart_label = parsed.get("chart_label") or "Graphique"

            if chart_type not in ("bar", "line", "pie", "area"):
                chart_type = "bar"

            if chart_sql:
                chart_sql = _fix_parquet_paths(chart_sql, parquet_dir)

            if chart_sql and _validate_sql(chart_sql):
                return {
                    "chartable": True,
                    "reason": reason,
                    "chart_sql_query": chart_sql,
                    "chart_type": chart_type,
                    "chart_label": chart_label,
                }

            return {
                "chartable": True,
                "reason": reason,
                "chart_sql_query": None,
                "chart_type": chart_type,
                "chart_label": chart_label,
            }

        except Exception as exc:
            logger.warning("ChartSQLNode parse error: %s", exc)
            return {
                "chartable": False,
                "reason": str(exc),
                "chart_sql_query": None,
                "chart_type": None,
                "chart_label": None,
            }

    def post(
        self,
        shared: Dict[str, Any],
        prep_result: Dict[str, Any],
        exec_result: Dict[str, Any],
    ) -> str:
        shared["chart_sql_query"] = exec_result.get("chart_sql_query")
        shared["chart_type"] = exec_result.get("chart_type")
        shared["chart_label"] = exec_result.get("chart_label")
        shared["chart_reason"] = exec_result.get("reason")
        shared["chartable"] = exec_result.get("chartable", False)
        return "default"


if __name__ == "__main__":
    from nodes.thinking.sql_execution_node import SQLExecutionNode

    node = ChartSQLNode()
    exec_node = SQLExecutionNode()

    shared: Dict[str, Any] = {
        "query": "Le marché ukrainien ou d'Europe de l'Est représente-t-il une opportunité sous-exploitée ?",
        "sql_queries": [
            {
                "label": "Top 10 nationalités par arrivées en 2024",
                "sql": """
                    SELECT Nationalite,
                           ROUND(SUM(TotalArrivees), 0) AS total_arrivees
                    FROM read_parquet('data/parquet/arriver.parquet')
                    WHERE Annee = 2024
                    GROUP BY Nationalite
                    ORDER BY total_arrivees DESC
                    LIMIT 10
                """,
            },
            {
                "label": "Nombre de postes frontaliers actifs par année",
                "sql": """
                    SELECT Annee,
                           COUNT(DISTINCT Nom_Poste_Frontiere) AS nb_postes_actifs
                    FROM read_parquet('data/parquet/apf.parquet')
                    GROUP BY Annee
                    ORDER BY Annee
                """,
            },
            {
                "label": "Destination la plus fréquentée en 2024",
                "sql": """
                    SELECT Destination
                    FROM read_parquet('data/parquet/arriver.parquet')
                    WHERE Annee = 2024
                    GROUP BY Destination
                    ORDER BY SUM(TotalArrivees) DESC
                    LIMIT 1
                """,
            },
        ],
    }

    exec_node.run(shared)
    node.run(shared)

    print("\n" + "=" * 60)
    print("Chartable:", shared.get("chartable"))
    print("Chart type:", shared.get("chart_type"))
    print("Chart label:", shared.get("chart_label"))
    print("Reason:", shared.get("chart_reason"))
    if shared.get("chart_sql_query"):
        print("Chart SQL:\n", shared["chart_sql_query"])
