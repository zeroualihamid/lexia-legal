"""
CategoricalDistinctNode — Extract distinct values of categorical columns,
generate definitions, and compute embeddings.

Reads a parquet file and a ColumnsClasses DTO, selects only the columns
marked ``is_categorical=True``, computes their distinct (non-null) values,
generates a definition for each value (expanding abbreviations), embeds
both the value and its definition, and writes a ``<stem>_distinct.parquet``.

Output parquet columns:
    column_name      (str):        categorical field name
    distinct_value   (str):        one distinct value
    definition_values (str):       JSON list of definitions for the value
    embedded_values   (str):       JSON list of embedding vectors (one per text)

Inputs (via shared state):
- ``parquet_path``       (str | Path): Source parquet file.
- ``columns_classes``    (ColumnsClasses): DTO with column definitions.
- ``distinct_output``    (optional, str | Path): Output path.
- ``embedding_model``    (optional, str): SentenceTransformer model name.

Outputs (via shared state):
- ``distinct_parquet_path``   (str): Path to the written distinct parquet.
- ``distinct_summary``        (dict): {column_name: count_of_distinct_values, ...}
"""

from __future__ import annotations

import json
import re
import yaml
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd
import pyarrow.parquet as _pq
import pyarrow.compute as _pac
from sentence_transformers import SentenceTransformer

from nodes.base_node import BaseNode
from nodes.dataloader.parquet_writer_node import write_parquet
from monitoring.logger import get_logger
from llm.llm_factory import get_llm
from config import get_settings

logger = get_logger(__name__)

DEFAULT_EMBEDDING_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"

_LLM_BATCH_SIZE = 40
_HIGH_CARDINALITY_THRESHOLD = 50
_TRAILING_NUMBER_RE = re.compile(r"^(.+?)\s+\d+$")


def _strip_trailing_number(value: str) -> str:
    """Return the base form of *value* by removing a trailing `` N`` suffix."""
    m = _TRAILING_NUMBER_RE.match(value)
    return m.group(1) if m else value


def _collapse_numbered_variants(values: List[str]) -> Tuple[List[str], Dict[str, str]]:
    """Collapse values like ``"Name 1"``, ``"Name 2"`` into their base ``"Name"``.

    Returns:
        base_values: deduplicated base forms (sorted)
        variant_to_base: mapping from every original value to its base form
    """
    variant_to_base: Dict[str, str] = {}
    bases_seen: set = set()
    for v in values:
        base = _strip_trailing_number(v)
        variant_to_base[v] = base
        bases_seen.add(base)
    return sorted(bases_seen), variant_to_base


def _llm_definitions_for_bases(
    base_values: List[str],
    column_name: str,
    llm_client,
    model: str,
) -> Dict[str, List[str]]:
    """Call the LLM to produce definitions for a list of *unique base* values."""
    if not base_values:
        return {}

    result: Dict[str, List[str]] = {}

    for batch_start in range(0, len(base_values), _LLM_BATCH_SIZE):
        batch = base_values[batch_start : batch_start + _LLM_BATCH_SIZE]
        numbered = "\n".join(f"{i+1}. {v}" for i, v in enumerate(batch))

        from prompt_loader import render_template
        prompt = render_template(
            "dataloader", "categorical_definitions",
            column_name=column_name,
            numbered_values=numbered,
        )

        try:
            response = llm_client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
            )
            raw = response.choices[0].message.content or ""

            yaml_str = raw
            if "```yaml" in raw:
                yaml_str = raw.split("```yaml", 1)[1].split("```", 1)[0]
            elif "```" in raw:
                yaml_str = raw.split("```", 1)[1].split("```", 1)[0]

            parsed = yaml.safe_load(yaml_str)
            if isinstance(parsed, list):
                for entry in parsed:
                    val = str(entry.get("value", "")).strip()
                    defs = entry.get("definitions", [])
                    if isinstance(defs, str):
                        defs = [defs]
                    defs = [str(d) for d in defs if d]
                    if val and defs:
                        result[val] = defs

        except Exception as exc:
            logger.warning("LLM definition call failed for column '%s' (batch %d): %s",
                           column_name, batch_start, exc)

        for v in batch:
            if v not in result:
                result[v] = [v]

    return result


def _column_level_definition(
    sample_values: List[str],
    column_name: str,
    llm_client,
    model: str,
) -> str:
    """Ask the LLM once to describe *what kind of data* a column contains.

    Used for high-cardinality columns (e.g. personal names, addresses) where
    per-value definitions are redundant.  Returns a short generic description.
    """
    from prompt_loader import render_template
    sample = sample_values[:20]
    sample_text = ", ".join(f'"{v}"' for v in sample)
    prompt = render_template(
        "dataloader", "column_level_definition",
        column_name=column_name,
        sample_text=sample_text,
    )
    try:
        response = llm_client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
        )
        desc = (response.choices[0].message.content or "").strip().strip('"').strip("'")
        if desc:
            return desc
    except Exception as exc:
        logger.warning("Column-level definition LLM call failed for '%s': %s", column_name, exc)
    return column_name


def _generate_definitions_llm(
    values: List[str],
    column_name: str,
    llm_client,
    model: str,
) -> Dict[str, List[str]]:
    """Produce definitions for categorical values, collapsing numbered variants.

    ``"Name"``, ``"Name 1"``, ``"Name 2"`` all share the definition of ``"Name"``.

    For high-cardinality columns (> ``_HIGH_CARDINALITY_THRESHOLD`` unique base
    values), a single column-level description is generated and applied to every
    value instead of calling the LLM per-value.
    """
    if not values:
        return {}

    base_values, variant_to_base = _collapse_numbered_variants(values)

    collapsed = len(values) - len(base_values)
    if collapsed > 0:
        logger.info(
            "Column '%s': collapsed %d numbered variants → %d unique base values",
            column_name, len(values), len(base_values),
        )

    if len(base_values) > _HIGH_CARDINALITY_THRESHOLD:
        logger.info(
            "Column '%s': %d unique base values exceeds threshold (%d) — "
            "using single column-level definition (1 LLM call instead of %d)",
            column_name, len(base_values), _HIGH_CARDINALITY_THRESHOLD,
            (len(base_values) + _LLM_BATCH_SIZE - 1) // _LLM_BATCH_SIZE,
        )
        generic_def = _column_level_definition(base_values, column_name, llm_client, model)
        return {v: [generic_def] for v in values}

    base_defs = _llm_definitions_for_bases(base_values, column_name, llm_client, model)

    result: Dict[str, List[str]] = {}
    for v in values:
        base = variant_to_base[v]
        result[v] = base_defs.get(base, [base])
    return result


def _embed_texts(model: SentenceTransformer, texts: List[str]) -> List[List[float]]:
    """Encode a list of texts and return embedding vectors."""
    if not texts:
        return []
    return model.encode(texts, show_progress_bar=False).tolist()


class CategoricalDistinctNode(BaseNode):
    """Extract distinct values, definitions, and embeddings for categorical fields."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "CategoricalDistinct")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)

        parquet_path = shared.get("parquet_path")
        if not parquet_path:
            raise ValueError("CategoricalDistinctNode requires 'parquet_path' in shared state")
        parquet_path = Path(parquet_path)
        if not parquet_path.is_file():
            raise FileNotFoundError(f"Parquet file not found: {parquet_path}")

        columns_classes = shared.get("columns_classes")
        if not columns_classes:
            raise ValueError("CategoricalDistinctNode requires 'columns_classes' in shared state")

        output_path = shared.get("distinct_output")
        if output_path:
            output_path = Path(output_path)
        else:
            output_path = parquet_path.with_name(parquet_path.stem + "_distinct.parquet")

        model_name = shared.get("embedding_model", DEFAULT_EMBEDDING_MODEL)

        return {
            "parquet_path": parquet_path,
            "columns_classes": columns_classes,
            "output_path": output_path,
            "model_name": model_name,
        }

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        parquet_path: Path = prep_result["parquet_path"]
        columns_classes = prep_result["columns_classes"]
        output_path: Path = prep_result["output_path"]
        embedding_model_name: str = prep_result["model_name"]

        categorical_names = columns_classes.get_categorical_column_names()
        if not categorical_names:
            self.logger.warning("No categorical columns found in DTO — nothing to extract")
            return {"output_path": str(output_path), "summary": {}, "skipped": True}

        llm_client, _ = get_llm()
        llm_model = get_settings().llm.model
        self.logger.info(f"Using LLM '{llm_model}' for definition generation")

        # Read column names from the parquet schema WITHOUT loading any rows.
        # Loading the full parquet (e.g. 8.4M rows × 100+ cols) into one
        # DataFrame here was the sudden multi-GB spike that OOM-killed the agent
        # on large QVD sources — we only need distinct values of the categorical
        # columns, computed one column at a time below.
        schema_names = _pq.ParquetFile(parquet_path).schema_arrow.names

        present = [c for c in categorical_names if c in schema_names]
        missing = [c for c in categorical_names if c not in schema_names]
        if missing:
            self.logger.warning(f"Categorical columns not in parquet: {missing}")

        rows: list[dict] = []
        all_texts: list[str] = []
        text_index_map: list[tuple[int, int, int]] = []

        summary: Dict[str, int] = {}
        for col in present:
            # Read ONLY this column (one column of N rows is small) and dedupe
            # via Arrow — bounded memory regardless of table width or length.
            col_table = _pq.read_table(parquet_path, columns=[col])
            distinct = _pac.unique(col_table.column(0).drop_null()).to_pylist()
            del col_table
            distinct_str = sorted(set(str(v) for v in distinct))
            summary[col] = len(distinct_str)

            self.logger.info(f"Generating definitions for column '{col}' ({len(distinct_str)} values) …")
            col_defs = _generate_definitions_llm(distinct_str, col, llm_client, llm_model)

            for val in distinct_str:
                defs = col_defs.get(val, [val])
                row_idx = len(rows)
                texts_for_row = [val] + defs
                start = len(all_texts)
                all_texts.extend(texts_for_row)
                end = len(all_texts)
                text_index_map.append((row_idx, start, end))
                rows.append({
                    "column_name": col,
                    "distinct_value": val,
                    "definition_values": json.dumps(defs, ensure_ascii=False),
                    "embedded_values": None,
                })

        if not rows:
            self.logger.warning("All categorical columns are empty — writing empty parquet")
            out_df = pd.DataFrame(columns=["column_name", "distinct_value", "definition_values", "embedded_values"])
        else:
            self.logger.info(f"Embedding {len(all_texts):,} texts with {embedding_model_name} …")
            from services.embedding_model_provider import get_embedding_model
            model = get_embedding_model(embedding_model_name)
            all_embeddings = _embed_texts(model, all_texts)

            for row_idx, start, end in text_index_map:
                row_embeddings = all_embeddings[start:end]
                rows[row_idx]["embedded_values"] = json.dumps(row_embeddings)

            out_df = pd.DataFrame(rows)

        write_parquet(out_df, output_path)

        total = sum(summary.values())
        self.logger.info(
            f"Extracted {total:,} distinct values across {len(present)} categorical columns → {output_path}"
        )
        return {"output_path": str(output_path), "summary": summary, "skipped": False}

    def post(self, shared: Dict[str, Any], prep_result: Any, exec_result: Dict[str, Any]) -> str:
        shared["distinct_parquet_path"] = exec_result["output_path"]
        shared["distinct_summary"] = exec_result.get("summary", {})
        self.log_exit("default")
        return "default"


def load_dto_for_parquet(parquet_path: str | Path) -> Any:
    """Dynamically import get_columns_descriptions from the DTO matching the parquet stem.

    Looks for ``data.classes.dtos.<stem>_dto.get_columns_descriptions``.
    """
    import importlib

    stem = Path(parquet_path).stem
    module_path = f"data.classes.dtos.{stem}_dto"
    try:
        mod = importlib.import_module(module_path)
        mod = importlib.reload(mod)
    except ModuleNotFoundError:
        raise ImportError(
            f"No DTO module found for '{stem}': expected {module_path}"
        )
    fn = getattr(mod, "get_columns_descriptions", None)
    if fn is None:
        raise ImportError(f"{module_path} has no get_columns_descriptions()")
    return fn()


if __name__ == "__main__":
    import sys
    _root = str(Path(__file__).resolve().parent.parent.parent)
    sys.path.insert(0, _root)
    sys.path.insert(0, str(Path(_root) / "data"))

    parquet_file = sys.argv[1] if len(sys.argv) > 1 else "data/parquet/Data_Finance_banque.parquet"
    columns_classes = load_dto_for_parquet(parquet_file)

    node = CategoricalDistinctNode()
    shared = {
        "parquet_path": parquet_file,
        "columns_classes": columns_classes,
    }

    prep_result = node.prep(shared)
    exec_result = node.exec(prep_result)
    node.post(shared, prep_result, exec_result)

    print(f"\nDistinct parquet: {shared['distinct_parquet_path']}")
    print(f"Summary: {shared['distinct_summary']}")

    result_df = pd.read_parquet(shared["distinct_parquet_path"])
    print(f"\nTotal rows: {len(result_df)}")
    print(f"Columns: {list(result_df.columns)}")

    for _, row in result_df.head(5).iterrows():
        print(f"\n--- {row['column_name']}: {row['distinct_value']}")
        defs = json.loads(row["definition_values"])
        print(f"    definitions: {defs}")
        embs = json.loads(row["embedded_values"])
        print(f"    embeddings count: {len(embs)}, dim: {len(embs[0]) if embs else 0}")
