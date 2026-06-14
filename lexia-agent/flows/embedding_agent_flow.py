"""
Embedding Agent Flow — Reasoning-capable embedding pipeline with SSE events.

Pipeline steps (emitted as events to the frontend):
    1. resolve    – Load datasource config + DTO
    2. load_data  – Read source parquet, identify categorical columns
    3. distinct   – Per-column: extract distinct values, collapse variants
    4. definitions – Per-column: LLM definition generation (with batch info)
    5. embed      – Encode all texts with SentenceTransformer
    6. write      – Write output parquet (distinct + embeddings)
    7. done / failed

Triggered by:
    POST /parquet/embedding-agent/{source_id}
"""

from __future__ import annotations

import importlib
import json
import logging
import re
import sys
import time
import yaml
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import pandas as pd

logger = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_DATA_DIR = _PROJECT_ROOT / "data"

_LLM_BATCH_SIZE = 40
_HIGH_CARDINALITY_THRESHOLD = 50
_TRAILING_NUMBER_RE = re.compile(r"^(.+?)\s+\d+$")


EmitFn = Callable[..., None]


def _ensure_data_on_path() -> None:
    s = str(_DATA_DIR)
    if s not in sys.path:
        sys.path.insert(0, s)


def _load_columns_classes(columns_class_ref: str):
    _ensure_data_on_path()
    if ":" in columns_class_ref:
        mod_path, func_name = columns_class_ref.split(":", 1)
    else:
        mod_path = columns_class_ref
        func_name = "get_columns_descriptions"
    mod = importlib.import_module(mod_path)
    mod = importlib.reload(mod)
    return getattr(mod, func_name)()


def _resolve_parquet_path(source_cfg: dict) -> Optional[Path]:
    raw = source_cfg.get("cache_file")
    if not raw:
        return None
    p = Path(raw)
    if p.is_absolute() and p.exists():
        return p
    cache_dir = _PROJECT_ROOT / "data" / "parquet"
    if (cache_dir / p.name).exists():
        return cache_dir / p.name
    if p.exists():
        return p
    return None


def _resolve_effective_config(
    source_cfg: Dict[str, Any],
    table_id: Optional[str],
) -> Dict[str, Any]:
    if table_id and source_cfg.get("tables"):
        tables = source_cfg["tables"]
        for tbl in tables:
            tbl_dict = tbl.dict() if hasattr(tbl, "dict") else dict(tbl)
            if tbl_dict.get("table_id") == table_id:
                return {**source_cfg, **tbl_dict}
    return source_cfg


def _strip_trailing_number(value: str) -> str:
    m = _TRAILING_NUMBER_RE.match(value)
    return m.group(1) if m else value


def _collapse_numbered_variants(values: List[str]) -> Tuple[List[str], Dict[str, str]]:
    variant_to_base: Dict[str, str] = {}
    bases_seen: set = set()
    for v in values:
        base = _strip_trailing_number(v)
        variant_to_base[v] = base
        bases_seen.add(base)
    return sorted(bases_seen), variant_to_base


def run_embedding_agent(
    source_id: str,
    categorical_columns: List[str],
    table_id: Optional[str] = None,
    job: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Run the full embedding pipeline with live event reporting.

    Args:
        source_id: datasource identifier.
        categorical_columns: column names the user marked as categorical.
        table_id: for multi-table sources.
        job: mutable job dict shared with the API layer for live SSE updates.

    Returns:
        Dict with success, summary, duration_ms, distinct_parquet_path.
    """
    from config import get_settings
    from llm.llm_factory import get_llm

    t0 = time.perf_counter()
    events: list = job["events"] if job else []

    def emit(step: str, message: str, **kw):
        evt = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "step": step,
            "message": message,
            **kw,
        }
        events.append(evt)
        logger.info("[EmbeddingAgent] %s — %s", step, message)
        if job is not None:
            job["last_event"] = evt
            job["events"] = events

    result: Dict[str, Any] = {
        "success": False,
        "source_id": source_id,
        "table_id": table_id,
        "summary": {},
        "distinct_parquet_path": None,
        "error": None,
    }

    # ── Step 1: Resolve config ─────────────────────────────────────────
    emit("resolve", f"Résolution de la configuration pour '{source_id}'…")
    # Always reload settings so the agent picks up edits made to
    # config/datasources.yaml since startup (e.g. ``columns_class`` added
    # right after an XLSX upload).  Without ``reload=True`` the cached
    # singleton can lag behind disk and surface as "No columns_class".
    settings = get_settings(reload=True)
    source_cfg = next(
        (s for s in (settings.data_sources or []) if s.source_id == source_id),
        None,
    )
    if source_cfg is not None:
        source_cfg = source_cfg.dict() if hasattr(source_cfg, "dict") else dict(source_cfg)
    if not source_cfg:
        emit("failed", f"Source introuvable : {source_id}")
        result["error"] = f"Source config not found: {source_id}"
        return result

    effective = _resolve_effective_config(source_cfg, table_id)
    emit("resolve", f"Configuration résolue — table : {table_id or 'principale'}")

    # ── Step 2: Load DTO ───────────────────────────────────────────────
    columns_class_ref = effective.get("columns_class", "")
    if not columns_class_ref:
        emit("failed", f"Aucune columns_class configurée pour {source_id}/{table_id or ''}")
        result["error"] = f"No columns_class for {source_id}"
        return result

    emit("load_dto", f"Chargement du DTO : {columns_class_ref}…")
    try:
        full_cc = _load_columns_classes(columns_class_ref)
    except Exception as e:
        emit("failed", f"Échec de chargement du DTO : {e}")
        result["error"] = f"DTO load failed: {e}"
        return result
    emit("load_dto", f"DTO chargé — {len(full_cc.columns)} colonnes définies")

    # ── Step 3: Filter categorical columns ─────────────────────────────
    from data.classes.columns_classes import ColumnClass, ColumnsClasses
    selected_set = set(categorical_columns)
    filtered_columns = []
    for col in full_cc.columns:
        if col.column_name in selected_set:
            d = col.model_dump() if hasattr(col, "model_dump") else col.dict()
            d["is_categorical"] = True
            filtered_columns.append(ColumnClass(**d))

    if not filtered_columns:
        emit("failed", "Aucune colonne catégorielle trouvée dans le DTO")
        result["error"] = "No matching categorical columns"
        return result

    col_names = [c.column_name for c in filtered_columns]
    emit("filter", f"{len(filtered_columns)} colonnes catégorielles sélectionnées : {', '.join(col_names)}")

    # ── Step 4: Load source parquet ────────────────────────────────────
    parquet_path = _resolve_parquet_path(effective)
    if not parquet_path or not parquet_path.exists():
        emit("failed", f"Fichier parquet source introuvable pour {source_id}")
        result["error"] = "Source parquet not found"
        return result

    # Quick integrity check: valid parquet must end with b'PAR1'
    try:
        with open(parquet_path, "rb") as _f:
            _f.seek(-4, 2)
            if _f.read(4) != b"PAR1":
                emit("failed", (
                    f"Fichier parquet corrompu : {parquet_path.name} — "
                    f"les magic bytes de fin sont absents. "
                    f"Veuillez re-télécharger les données via « Télécharger Parquet »."
                ))
                result["error"] = "Corrupt parquet: missing PAR1 footer"
                return result
    except Exception:
        pass

    emit("load_data", f"Lecture du parquet source : {parquet_path.name}…")
    try:
        df = pd.read_parquet(parquet_path)
    except Exception as e:
        emit("failed", (
            f"Fichier parquet corrompu ou invalide : {parquet_path.name} — "
            f"Veuillez d'abord re-télécharger les données via « Télécharger Parquet ». "
            f"Détail : {e}"
        ))
        result["error"] = f"Corrupt parquet: {e}"
        return result
    emit("load_data", f"Parquet chargé — {len(df):,} lignes × {len(df.columns)} colonnes")

    present = [c for c in col_names if c in df.columns]
    missing = [c for c in col_names if c not in df.columns]
    if missing:
        emit("warning", f"Colonnes absentes du parquet : {', '.join(missing)}")

    # ── Step 5: Extract distinct values per column ─────────────────────
    emit("distinct", "Extraction des valeurs distinctes par colonne…")
    llm_client, _ = get_llm()
    llm_model = settings.llm.model

    from services.embedding_model_provider import DEFAULT_EMBEDDING_MODEL

    rows: list = []
    all_texts: list = []
    text_index_map: list = []
    summary: Dict[str, int] = {}
    total_columns = len(present)

    for col_idx, col in enumerate(present, 1):
        distinct = df[col].dropna().unique().tolist()
        distinct_str = sorted(set(str(v) for v in distinct))
        summary[col] = len(distinct_str)

        emit("distinct", (
            f"[{col_idx}/{total_columns}] {col} — "
            f"{len(distinct_str)} valeurs distinctes"
        ), column=col, col_index=col_idx, total_columns=total_columns,
           distinct_count=len(distinct_str))

        # Collapse numbered variants
        base_values, variant_to_base = _collapse_numbered_variants(distinct_str)
        collapsed = len(distinct_str) - len(base_values)
        if collapsed > 0:
            emit("reasoning", (
                f"  {col} : {collapsed} variantes numérotées regroupées → "
                f"{len(base_values)} bases uniques"
            ), column=col)

        # ── LLM definitions ────────────────────────────────────────────
        if len(base_values) > _HIGH_CARDINALITY_THRESHOLD:
            emit("reasoning", (
                f"  {col} : haute cardinalité ({len(base_values)} bases > {_HIGH_CARDINALITY_THRESHOLD}) "
                f"→ définition générique unique (1 appel LLM)"
            ), column=col)

            from prompt_loader import render_template
            sample_text = ", ".join(f'"{v}"' for v in base_values[:20])
            prompt = render_template(
                "dataloader", "column_level_definition",
                column_name=col, sample_text=sample_text,
            )
            try:
                response = llm_client.chat.completions.create(
                    model=llm_model,
                    messages=[{"role": "user", "content": prompt}],
                )
                generic_def = (response.choices[0].message.content or "").strip().strip('"').strip("'")
                if not generic_def:
                    generic_def = col
            except Exception as exc:
                emit("warning", f"  {col} : échec LLM définition colonne — {exc}", column=col)
                generic_def = col

            col_defs = {v: [generic_def] for v in distinct_str}
            emit("definitions", (
                f"  {col} : définition générique appliquée à {len(distinct_str)} valeurs"
            ), column=col)

        else:
            n_batches = (len(base_values) + _LLM_BATCH_SIZE - 1) // _LLM_BATCH_SIZE
            emit("definitions", (
                f"  {col} : génération des définitions LLM — "
                f"{len(base_values)} valeurs en {n_batches} lot(s)"
            ), column=col)

            base_defs: Dict[str, List[str]] = {}
            for batch_start in range(0, len(base_values), _LLM_BATCH_SIZE):
                batch = base_values[batch_start:batch_start + _LLM_BATCH_SIZE]
                batch_num = batch_start // _LLM_BATCH_SIZE + 1
                emit("definitions_batch", (
                    f"  {col} : lot {batch_num}/{n_batches} — {len(batch)} valeurs"
                ), column=col, batch=batch_num, total_batches=n_batches)

                numbered = "\n".join(f"{i+1}. {v}" for i, v in enumerate(batch))
                from prompt_loader import render_template
                prompt = render_template(
                    "dataloader", "categorical_definitions",
                    column_name=col, numbered_values=numbered,
                )

                try:
                    response = llm_client.chat.completions.create(
                        model=llm_model,
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
                                base_defs[val] = defs
                except Exception as exc:
                    emit("warning", (
                        f"  {col} : lot {batch_num} — échec LLM : {exc}"
                    ), column=col)

                for v in batch:
                    if v not in base_defs:
                        base_defs[v] = [v]

            col_defs = {}
            for v in distinct_str:
                base = variant_to_base[v]
                col_defs[v] = base_defs.get(base, [base])

            emit("definitions", (
                f"  {col} : {len(col_defs)} définitions générées ✓"
            ), column=col)

        # Build rows for this column
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
        emit("failed", "Aucune donnée à traiter — colonnes catégorielles vides")
        result["error"] = "No data to embed"
        return result

    # ── Step 6: Embedding ──────────────────────────────────────────────
    emit("embed", (
        f"Chargement du modèle d'embedding : {DEFAULT_EMBEDDING_MODEL}…"
    ))
    from services.embedding_model_provider import get_embedding_model
    model = get_embedding_model(DEFAULT_EMBEDDING_MODEL)

    emit("embed", f"Encoding {len(all_texts):,} textes…", total_texts=len(all_texts))
    all_embeddings = model.encode(all_texts, show_progress_bar=False).tolist()

    for row_idx, start, end in text_index_map:
        row_embeddings = all_embeddings[start:end]
        rows[row_idx]["embedded_values"] = json.dumps(row_embeddings)

    emit("embed", f"Embedding terminé — {len(all_embeddings):,} vecteurs générés ✓")

    # ── Step 7: Write parquet ──────────────────────────────────────────
    embeddings_file = effective.get("embeddings_file")
    if embeddings_file:
        ep = Path(embeddings_file)
        if not ep.is_absolute():
            ep = _PROJECT_ROOT / "data" / "parquet" / ep.name
        output_path = ep
    else:
        output_path = parquet_path.with_name(parquet_path.stem + "_embeddings.parquet")

    emit("write", f"Écriture du fichier parquet : {output_path.name}…")
    out_df = pd.DataFrame(rows)

    from nodes.dataloader.parquet_writer_node import write_parquet
    write_parquet(out_df, output_path)

    total = sum(summary.values())
    emit("write", (
        f"Fichier écrit — {total:,} valeurs distinctes dans "
        f"{len(present)} colonnes → {output_path.name} ✓"
    ))

    # ── Done ───────────────────────────────────────────────────────────
    elapsed = round((time.perf_counter() - t0) * 1000, 1)
    emit("done", (
        f"Pipeline terminé en {elapsed/1000:.1f}s — "
        f"{total:,} embeddings dans {len(present)} colonnes"
    ), elapsed=elapsed / 1000)

    result.update({
        "success": True,
        "summary": summary,
        "distinct_parquet_path": str(output_path),
        "duration_ms": elapsed,
    })
    return result
