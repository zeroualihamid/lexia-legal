"""
QVD Full Pipeline Flow — QVD → Field Description → Parquet → Categorical Distinct → Register.

Pipeline:
    QVDFieldDescription → QVDRead → ParquetBridge → ParquetWriter
        → DistinctBridge → CategoricalDistinct → RegisterDatasource

Fetches and chains:
- QVDFieldDescriptionNode: extracts field names, writes YAML + DTO
- QVDReadNode: reads QVD into DataFrame
- ParquetWriterNode: writes DataFrame to parquet
- CategoricalDistinctNode: extracts distinct categorical values, definitions, embeddings
- RegisterDatasourceNode: upserts a data_sources entry in config/datasources.yaml

Shared-state contract (caller must provide):
──────────────────────────────────────────────
  Required:
    qvd_path          (str | Path)  – source QVD file
    parquet_output    (str | Path)  – target parquet path (e.g. data/parquet/apf.parquet)

  Optional:
    output_yaml_path  (str | Path)  – field description YAML path
    output_dto_path   (str | Path)  – DTO Python module path
    distinct_output   (str | Path)  – distinct parquet path (default: <stem>_distinct.parquet)

Outputs written back to shared:
    field_description_yaml   – path to YAML
    field_description_dto   – path to DTO module
    file_description       – LLM-generated file description
    qvd_dataframe          – raw DataFrame from QVD
    parquet_write_results  – [{filename, rows, columns}]
    distinct_parquet_path  – path to distinct parquet
    distinct_summary       – {column_name: count, ...}
    registered_source_id   – source_id written to datasources.yaml
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, Optional

import yaml
from pocketflow import Flow, Node as PFNode

from nodes.dataloader.qvd_read_node import QVDReadNode
from nodes.dataloader.qvd_field_description_node import QVDFieldDescriptionNode
from nodes.dataloader.parquet_writer_node import ParquetWriterNode
from nodes.dataloader.categorical_distinct_node import CategoricalDistinctNode, load_dto_for_parquet

from monitoring.logger import get_logger

logger = get_logger(__name__)


class _QVDFieldDescriptionBridgeNode(PFNode):
    """Runs QVDFieldDescriptionNode and continues (it normally returns 'end')."""

    def prep(self, shared):
        return shared.get("qvd_path")

    def exec(self, prep_res):
        return prep_res

    def post(self, shared, prep_res, exec_res):
        node = QVDFieldDescriptionNode()
        node.run(shared)
        return "default"


class _ParquetBridgeNode(PFNode):
    """Adapts QVDReadNode output → ParquetWriterNode input."""

    def prep(self, shared):
        return shared["qvd_dataframe"], shared["parquet_output"]

    def post(self, shared, prep_res, exec_res):
        df, output_path = prep_res
        shared["parquet_write_requests"] = [
            {"df": df, "filename": str(output_path)},
        ]
        return "default"


class _DistinctBridgeNode(PFNode):
    """Adapts ParquetWriterNode output → CategoricalDistinctNode input.

    Loads columns_classes from DTO matching the parquet stem.
    """

    def prep(self, shared):
        return shared.get("parquet_write_results")

    def post(self, shared, prep_res, exec_res):
        write_results = prep_res
        if not write_results:
            return "skip"
        parquet_path = write_results[0]["filename"]
        shared["parquet_path"] = parquet_path
        try:
            columns_classes = load_dto_for_parquet(parquet_path)
            shared["columns_classes"] = columns_classes
        except ImportError as e:
            logger.warning("Could not load DTO for %s: %s — skipping CategoricalDistinct", parquet_path, e)
            return "skip"
        return "default"


class _RegisterDatasourceNode(PFNode):
    """Upserts the QVD source entry into config/datasources.yaml after the
    pipeline finishes so the source is discoverable by the rest of the app."""

    _DATASOURCES_PATH = Path(__file__).resolve().parents[1] / "config" / "datasources.yaml"

    @staticmethod
    def _slugify(text: str) -> str:
        slug = re.sub(r"[^a-zA-Z0-9]+", "_", (text or "").strip()).strip("_").lower()
        return slug or "qvd_source"

    def prep(self, shared):
        return {
            "qvd_path": shared.get("qvd_path"),
            "parquet_output": shared.get("parquet_output"),
            "distinct_output": shared.get("distinct_output")
                or shared.get("distinct_parquet_path"),
            "field_description_dto": shared.get("field_description_dto"),
        }

    def post(self, shared, prep_res, exec_res):
        info = prep_res
        qvd_path = Path(str(info["qvd_path"]))
        parquet_output = Path(str(info["parquet_output"]))
        stem = parquet_output.stem

        source_id = self._slugify(stem) + "_qvd"

        project_root = self._DATASOURCES_PATH.parents[1]

        def _rel(p: Path) -> str:
            try:
                return str(p.relative_to(project_root))
            except ValueError:
                return str(p)

        cache_file = _rel(parquet_output)
        embeddings_file = info.get("distinct_output")
        if embeddings_file:
            embeddings_file = _rel(Path(str(embeddings_file)))
        else:
            embeddings_file = _rel(
                parquet_output.parent / f"{stem}_distinct.parquet"
            )

        dto_path = info.get("field_description_dto") or ""
        columns_class = ""
        if dto_path:
            dto_p = Path(str(dto_path))
            if not dto_p.is_absolute():
                dto_p = (project_root / dto_p).resolve()
            try:
                rel = dto_p.relative_to(project_root / "data")
            except ValueError:
                try:
                    rel = dto_p.relative_to(project_root)
                except ValueError:
                    rel = dto_p
            columns_class = str(rel.with_suffix("")).replace("/", ".").replace("\\", ".")

        source_entry = {
            "source_id": source_id,
            "type": "qvd",
            "enabled": True,
            "path": _rel(qvd_path),
            "chunk_size": 100000,
            "refresh_policy": "manual",
            "columns_class": columns_class,
            "cache_file": cache_file,
            "embeddings_file": embeddings_file,
        }

        ds_path = self._DATASOURCES_PATH
        data: Dict[str, Any] = {}
        if ds_path.exists():
            with open(ds_path, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}

        sources = data.setdefault("data_sources", [])

        existing = next(
            (s for s in sources
             if s.get("source_id") == source_id
             or s.get("path") == source_entry["path"]),
            None,
        )
        if existing is not None:
            existing.update(source_entry)
        else:
            sources.append(source_entry)

        data.pop("datasources", None)

        with open(ds_path, "w", encoding="utf-8") as f:
            yaml.dump(data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)

        shared["registered_source_id"] = source_id
        logger.info("Registered source '%s' in %s", source_id, ds_path)

        from config import get_settings
        get_settings(reload=True)

        return "default"


def create_qvd_full_pipeline_flow() -> Flow:
    """Assemble the full QVD → Field Description → Parquet → Distinct pipeline.

    Returns:
        A PocketFlow Flow starting at QVDFieldDescriptionBridge.
    """
    field_desc = _QVDFieldDescriptionBridgeNode()
    qvd_read = QVDReadNode()
    parquet_bridge = _ParquetBridgeNode()
    parquet_writer = ParquetWriterNode()
    distinct_bridge = _DistinctBridgeNode()
    categorical_distinct = CategoricalDistinctNode()
    register_ds = _RegisterDatasourceNode()

    field_desc >> qvd_read >> parquet_bridge >> parquet_writer >> distinct_bridge >> categorical_distinct >> register_ds
    flow_end = PFNode()
    distinct_bridge - "skip" >> register_ds >> flow_end

    return Flow(start=field_desc)


def run_qvd_full_pipeline(
    qvd_path: str | Path,
    parquet_output: str | Path,
    *,
    output_yaml_path: Optional[str | Path] = None,
    output_dto_path: Optional[str | Path] = None,
    distinct_output: Optional[str | Path] = None,
) -> Dict[str, Any]:
    """Run the full QVD pipeline: field description, parquet write, categorical distinct.

    Args:
        qvd_path: Path to the source .qvd file.
        parquet_output: Destination parquet file path (e.g. data/parquet/apf.parquet).
        output_yaml_path: Optional path for field description YAML.
        output_dto_path: Optional path for DTO Python module.
        distinct_output: Optional path for distinct parquet (default: <stem>_distinct.parquet).

    Returns:
        The shared-state dict after the flow completes.
    """
    flow = create_qvd_full_pipeline_flow()

    shared: Dict[str, Any] = {
        "qvd_path": str(qvd_path),
        "parquet_output": str(parquet_output),
    }
    if output_yaml_path is not None:
        shared["output_yaml_path"] = str(output_yaml_path)
    if output_dto_path is not None:
        shared["output_dto_path"] = str(output_dto_path)
    if distinct_output is not None:
        shared["distinct_output"] = str(distinct_output)

    logger.info("Starting QVD full pipeline: %s → %s", qvd_path, parquet_output)
    flow.run(shared)
    logger.info("QVD full pipeline complete")

    return shared


if __name__ == "__main__":
    result = run_qvd_full_pipeline(
        qvd_path="data/raw/qvd_bank/produit_client.qvd",
        parquet_output="data/parquet/produit_client.parquet",
    )
    print("\nField description YAML:", result.get("field_description_yaml"))
    print("Field description DTO:", result.get("field_description_dto"))
    print("Parquet write:", result.get("parquet_write_results"))
    print("Distinct parquet:", result.get("distinct_parquet_path"))
    print("Distinct summary:", result.get("distinct_summary"))
