"""
SQLGenerationNode — Translate a natural-language query into DuckDB-compatible SQL.

This PocketFlow node:
1. Discovers all available DTO modules in ``data/classes/dtos/``.
2. Builds a rich schema context from ``get_file_description()`` and
   ``get_columns_descriptions()`` exposed by each DTO.
3. Injects conversation history via ``ConversationMemoryNode``.
4. Calls the LLM (via ``get_llm`` from ``llm_utils``) to produce one or more
   DuckDB SQL queries that answer the user's question.
5. Validates syntax via ``duckdb.parse()``.
6. Writes the query list back to shared state (ready for ``DuckDBQueryNode``).

Shared-state contract:
──────────────────────────────────────────────
  Required inputs:
      query              (str)  — natural-language question from the user

  Optional inputs:
      session_id         (str)  — conversation session id (default: "default")
      prior_response_data (Any) — previous response context to refine on
      sql_results        (list[dict]) — prior query results (from SQLExecutionNode)
      llm_response       (str)  — last assistant message (fed to memory)
      parquet_cache_dir  (str)  — override parquet directory

  Outputs:
      sql_queries        (list[dict])  — DuckDB query descriptors:
                                         [{"sql": ..., "parquet": ..., "alias": ...}, ...]
      sql_generation_raw (str)         — raw LLM response (for debugging)
      memory_messages    (list[dict])  — conversation context (via memory node)
      memory_context     (dict)        — memory stats
"""

from __future__ import annotations

import importlib
import re
import yaml
from pathlib import Path
from typing import Any, Dict, List, Optional

import duckdb

from nodes.base_node import BaseNode
from nodes.memory.conversation_memory_node import ConversationMemoryNode
from llm.llm_factory import get_llm
from config import get_settings
from config.settings import settings as pydantic_settings
from monitoring.logger import get_logger

logger = get_logger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_DTO_DIR = _PROJECT_ROOT / "data" / "classes" / "dtos"
_DATA_DIR = _PROJECT_ROOT / "data"


def _ensure_dto_importable() -> None:
    """Make sure ``data/`` is on sys.path so DTOs can ``from classes.columns_classes import …``."""
    import sys
    data_str = str(_DATA_DIR)
    if data_str not in sys.path:
        sys.path.insert(0, data_str)


def _discover_dtos() -> Dict[str, Any]:
    """Scan the DTO directory and import every ``*_dto.py`` module.

    Returns a mapping ``{stem: module}`` where *stem* is the parquet file
    stem (e.g. ``"arriver"`` for ``arriver_dto.py``).
    """
    _ensure_dto_importable()

    dtos: Dict[str, Any] = {}
    if not _DTO_DIR.is_dir():
        logger.warning("DTO directory not found: %s", _DTO_DIR)
        return dtos

    for path in sorted(_DTO_DIR.glob("*_dto.py")):
        module_name = f"classes.dtos.{path.stem}"
        stem = path.stem.removesuffix("_dto")
        try:
            mod = importlib.import_module(module_name)
            dtos[stem] = mod
            logger.debug("Loaded DTO: %s", module_name)
        except Exception as exc:
            logger.warning("Failed to import DTO %s: %s", module_name, exc)
    return dtos


def _build_schema_context(parquet_dir: Path) -> str:
    """Return a compact schema from the DTO KV cache, falling back to
    dynamic discovery when the cache is not yet populated (e.g. tests)."""
    from flows.dto_cache_flow import get_compact_schema

    cached = get_compact_schema(parquet_dir)
    if cached:
        return cached

    # Fallback: dynamic discovery (for standalone usage / tests)
    dtos = _discover_dtos()
    if not dtos:
        return "(No data sources available)"

    sections: List[str] = []
    for stem, mod in dtos.items():
        parquet_path = parquet_dir / f"{stem}.parquet"

        columns_classes = None
        if hasattr(mod, "get_columns_descriptions"):
            try:
                columns_classes = mod.get_columns_descriptions()
            except Exception:
                pass

        if not columns_classes:
            continue

        header = f"### {stem} → read_parquet('{parquet_path}')"
        col_parts: List[str] = []
        for col in columns_classes.columns:
            needs_quoting = any(c in col.column_name for c in " °*#@/\\(){}")
            name_display = f'"{col.column_name}"' if needs_quoting else col.column_name
            tags = ""
            if col.is_categorical:
                tags += " [CAT]"
            col_parts.append(f"{name_display} {col.type}{tags}")

        sections.append(f"{header}\n  " + ", ".join(col_parts))

    return "\n\n".join(sections)


def _build_system_prompt(schema_context: str, skills_context: str = "") -> str:
    from prompt_loader import render_template

    skills_section = ""
    if skills_context:
        skills_section = (
            "\n\n## Expertise métier (skills chargés)\n\n"
            f"{skills_context}\n\n"
            "Utilise ces connaissances métier (formules KPI, benchmarks, méthodologies) pour :\n"
            "- Choisir les requêtes les plus pertinentes\n"
            "- Appliquer les bonnes formules d'agrégation (taux de croissance, DMS, parts de marché…)\n"
            "- Produire des labels et alias compréhensibles par un décideur"
        )

    return render_template(
        "thinking", "sql_generation",
        skills_section=skills_section,
        schema_context=schema_context,
    )


_MAX_PRIOR_ROWS = 30
_MAX_COL_WIDTH = 40


def _format_sql_results(sql_results: List[Dict[str, Any]]) -> str:
    """Format prior SQL execution results into a compact text block for the LLM.

    Each result set is rendered as a labelled markdown table (capped to
    ``_MAX_PRIOR_ROWS`` rows) so the LLM can reference concrete data when
    generating follow-up queries.
    """
    if not sql_results:
        return ""

    sections: List[str] = []
    for r in sql_results:
        label = r.get("label", "Query")
        if r.get("error"):
            sections.append(f"### {label}\nERROR: {r['error']}")
            continue

        columns = r.get("columns", [])
        rows = r.get("rows", [])
        total = r.get("row_count", len(rows))

        if not columns or not rows:
            sections.append(f"### {label}\n(empty result set)")
            continue

        display_rows = rows[:_MAX_PRIOR_ROWS]

        def _trunc(val: Any) -> str:
            s = str(val) if val is not None else ""
            return s[:_MAX_COL_WIDTH] + "…" if len(s) > _MAX_COL_WIDTH else s

        header = "| " + " | ".join(columns) + " |"
        sep = "| " + " | ".join("---" for _ in columns) + " |"
        body_lines = [
            "| " + " | ".join(_trunc(cell) for cell in row) + " |"
            for row in display_rows
        ]
        table = "\n".join([header, sep, *body_lines])

        footer = ""
        if total > _MAX_PRIOR_ROWS:
            footer = f"\n… ({total} total rows, showing first {_MAX_PRIOR_ROWS})"

        sql_snippet = r.get("sql", "").strip()
        if len(sql_snippet) > 200:
            sql_snippet = sql_snippet[:200] + "…"

        sections.append(
            f"### {label}\nSQL: `{sql_snippet}`\n{table}{footer}"
        )

    return "\n\n".join(sections)


def _parse_sql_response(raw: str) -> List[Dict[str, Any]]:
    """Extract SQL queries from the LLM response (YAML or JSON)."""
    import json as _json

    yaml_str = raw
    if "```yaml" in raw:
        yaml_str = raw.split("```yaml", 1)[1].split("```", 1)[0]
    elif "```json" in raw:
        yaml_str = raw.split("```json", 1)[1].split("```", 1)[0]
    elif "```" in raw:
        yaml_str = raw.split("```", 1)[1].split("```", 1)[0]

    parsed = None
    # Try YAML first, fall back to JSON if it fails
    try:
        parsed = yaml.safe_load(yaml_str)
    except yaml.YAMLError:
        try:
            parsed = _json.loads(yaml_str)
        except _json.JSONDecodeError:
            pass

    if parsed is None:
        # Last resort: try JSON on the entire raw response
        try:
            parsed = _json.loads(raw)
        except _json.JSONDecodeError:
            raise ValueError("LLM response is neither valid YAML nor JSON")

    if not isinstance(parsed, dict) or "queries" not in parsed:
        raise ValueError("LLM response does not contain a 'queries' key")

    queries = parsed["queries"]
    if not isinstance(queries, list) or not queries:
        raise ValueError("'queries' must be a non-empty list")

    result = []
    for i, q in enumerate(queries):
        if not isinstance(q, dict) or "sql" not in q:
            continue
        entry: Dict[str, Any] = {
            "label": q.get("label", f"Query {i+1}"),
            "sql": q["sql"].strip(),
        }
        if q.get("target"):
            entry["target"] = q["target"]
        if q.get("source_id"):
            entry["source_id"] = q["source_id"]
        result.append(entry)
    return result


def _validate_sql(sql: str) -> None:
    """Raise if *sql* is not syntactically valid DuckDB SQL."""
    conn = duckdb.connect(":memory:")
    try:
        conn.execute(f"EXPLAIN {sql}")
    except duckdb.ParserException as exc:
        raise ValueError(f"Invalid SQL syntax: {exc}") from exc
    except duckdb.CatalogException:
        pass
    except duckdb.BinderException:
        pass
    finally:
        conn.close()


class SQLGenerationNode(BaseNode):
    """Translates a natural-language query into DuckDB SQL using LLM + DTO schema context.

    Parameters:
        max_retries:  Number of LLM call retries on parse/validation failure.
        use_memory:   Whether to integrate ConversationMemoryNode for context.
    """

    def __init__(
        self,
        name: Optional[str] = None,
        max_retries: int = 3,
        use_memory: bool = True,
    ):
        super().__init__(name or "SQLGeneration")
        self._max_retries = max_retries
        self._use_memory = use_memory

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)

        query = shared.get("query") or shared.get("user_query") or ""
        if not query:
            raise ValueError("SQLGenerationNode requires 'query' in shared state")

        session_id = shared.get("session_id", "default")
        prior_data = shared.get("prior_response_data")
        prior_sql_results = shared.get("sql_results")
        parquet_dir = Path(
            shared.get("parquet_cache_dir")
            or str(pydantic_settings.parquet_cache_dir)
        )

        schema_context = _build_schema_context(parquet_dir)
        skills_context = shared.get("skills_context", "")

        memory_messages: List[Dict[str, str]] = []
        if self._use_memory:
            try:
                mem_node = ConversationMemoryNode(
                    max_short_term=10,
                    token_budget=2000,
                )
                mem_shared: Dict[str, Any] = {
                    "session_id": session_id,
                    "user_query": query,
                    "memory_system_prompt": _build_system_prompt(schema_context, skills_context),
                }
                if shared.get("llm_response"):
                    mem_shared["llm_response"] = shared["llm_response"]
                if shared.get("memory_store"):
                    mem_shared["memory_store"] = shared["memory_store"]

                mem_prep = mem_node.prep(mem_shared)
                mem_exec = mem_node.exec(mem_prep)
                mem_node.post(mem_shared, mem_prep, mem_exec)

                memory_messages = mem_shared.get("memory_messages", [])
                shared["memory_messages"] = memory_messages
                shared["memory_context"] = mem_shared.get("memory_context", {})
                shared["memory_session"] = mem_shared.get("memory_session")
                if "memory_store" not in shared and "memory_store" in mem_shared:
                    shared["memory_store"] = mem_shared["memory_store"]
            except Exception as exc:
                logger.warning("Memory integration failed (non-critical): %s", exc)

        return {
            "query": query,
            "prior_data": prior_data,
            "prior_sql_results": prior_sql_results,
            "schema_context": schema_context,
            "skills_context": skills_context,
            "parquet_dir": str(parquet_dir),
            "memory_messages": memory_messages,
        }

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        query = prep_result["query"]
        prior_data = prep_result["prior_data"]
        prior_sql_results = prep_result.get("prior_sql_results")
        schema_context = prep_result["schema_context"]
        skills_context = prep_result.get("skills_context", "")
        parquet_dir = prep_result["parquet_dir"]
        memory_messages = prep_result["memory_messages"]

        sync_client, _ = get_llm()
        model = get_settings().llm.model

        user_content_parts = [f"Question: {query}"]

        formatted_results = _format_sql_results(prior_sql_results or [])
        if formatted_results:
            user_content_parts.append(
                "\n## Prior query results\n"
                "The following data was returned by previous queries. "
                "Use it as context — you may filter, drill-down, pivot, "
                "or build upon these results in your new queries.\n\n"
                f"{formatted_results}"
            )

        if prior_data and not prior_sql_results:
            user_content_parts.append(
                f"\nAdditional context from prior response:\n{prior_data}"
            )

        user_content = "\n".join(user_content_parts)

        if memory_messages:
            messages = list(memory_messages)
            if messages and messages[-1].get("role") == "user":
                messages[-1] = {"role": "user", "content": user_content}
            else:
                messages.append({"role": "user", "content": user_content})
        else:
            messages = [
                {"role": "system", "content": _build_system_prompt(schema_context, skills_context)},
                {"role": "user", "content": user_content},
            ]

        last_error: Optional[str] = None
        raw_response = ""

        for attempt in range(self._max_retries):
            if last_error:
                messages.append({
                    "role": "user",
                    "content": (
                        f"Your previous response had an error:\n{last_error}\n\n"
                        f"Please fix it and respond again with valid YAML."
                    ),
                })

            try:
                response = sync_client.chat.completions.create(
                    model=model,
                    messages=messages,
                )
                raw_response = response.choices[0].message.content or ""

                queries = _parse_sql_response(raw_response)

                for q in queries:
                    if q.get("target") != "live_sql":
                        _validate_sql(q["sql"])

                query_descriptors = []
                for q in queries:
                    parquet_refs = re.findall(r"read_parquet\(['\"]([^'\"]+)['\"]\)", q["sql"])
                    desc: Dict[str, Any] = {
                        "sql": q["sql"],
                        "label": q["label"],
                    }
                    if parquet_refs:
                        desc["parquet"] = parquet_refs
                    if q.get("target") == "live_sql":
                        desc["target"] = "live_sql"
                        desc["source_id"] = q.get("source_id", "")
                    query_descriptors.append(desc)

                self.logger.info(
                    "Generated %d SQL queries on attempt %d/%d",
                    len(query_descriptors), attempt + 1, self._max_retries,
                )
                return {
                    "queries": query_descriptors,
                    "raw_response": raw_response,
                }

            except Exception as exc:
                last_error = str(exc)
                self.logger.warning(
                    "SQL generation attempt %d/%d failed: %s",
                    attempt + 1, self._max_retries, last_error,
                )

        self.logger.error("SQL generation failed after %d attempts", self._max_retries)
        return {
            "queries": [],
            "raw_response": raw_response,
            "error": last_error,
        }

    def post(
        self,
        shared: Dict[str, Any],
        prep_result: Dict[str, Any],
        exec_result: Dict[str, Any],
    ) -> str:
        shared["sql_queries"] = exec_result.get("queries", [])
        shared["sql_generation_raw"] = exec_result.get("raw_response", "")

        if exec_result.get("error"):
            shared["sql_generation_error"] = exec_result["error"]
            self.log_exit("error")
            return "error"

        if not exec_result.get("queries"):
            self.log_exit("empty")
            return "empty"

        if shared.get("memory_session"):
            try:
                labels = [q.get("label", "") for q in exec_result["queries"]]
                shared["llm_response"] = (
                    f"Generated {len(exec_result['queries'])} SQL queries: "
                    + "; ".join(labels)
                )
            except Exception:
                pass

        self.log_exit("default")
        return "default"


if __name__ == "__main__":
    from nodes.thinking.sql_execution_node import SQLExecutionNode

    # --- Step 1: Initial query ---
    print("=" * 60)
    print("STEP 1 — Initial query")
    print("=" * 60)

    gen = SQLGenerationNode(use_memory=False)
    shared: Dict[str, Any] = {
        "query": "Quelles destinations enregistrent la croissance la plus forte en nuitées sur les 5 dernières années ?",
    }

    gen.run(shared)

    print("Generated SQL:")
    for q in shared.get("sql_queries", []):
        print(f"  [{q.get('label')}] {q['sql'][:100]}...")

    if shared.get("sql_generation_error"):
        print(f"ERROR: {shared['sql_generation_error']}")
        raise SystemExit(1)

    # --- Step 2: Execute ---
    print("\n" + "=" * 60)
    print("STEP 2 — Execute")
    print("=" * 60)

    exe = SQLExecutionNode()
    exe.run(shared)

    print(shared["sql_results_summary"])
    for r in shared["sql_results"]:
        if not r.get("error"):
            for row in r["rows"][:5]:
                print(f"  {row}")

    # --- Step 3: Follow-up using prior results ---
    print("\n" + "=" * 60)
    print("STEP 3 — Follow-up with prior results injected")
    print("=" * 60)

    shared["query"] = "Pour les 3 premières destinations, donne le détail par nationalité"

    gen2 = SQLGenerationNode(use_memory=False)
    gen2.run(shared)

    print("Follow-up SQL:")
    for q in shared.get("sql_queries", []):
        print(f"\n--- {q.get('label', 'Query')} ---")
        print(q["sql"])

    if shared.get("sql_generation_error"):
        print(f"ERROR: {shared['sql_generation_error']}")
