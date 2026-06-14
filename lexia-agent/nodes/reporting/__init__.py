"""Reporting nodes — template scanning, SQL validation/execution, rendering.

The package operates on the per-block model.  Each ``<div data-block="…">``
in the report template is the unit owning one CTE plus one prompt.  The
legacy per-field helpers were removed in Phase 6 of the
``div-block-cte-pivot`` plan; only block-aware nodes remain.
"""

from nodes.reporting.block_draft_node import (
    BlockDraftNode,
    BlockDraftReport,
)
from nodes.reporting.block_validate_node import BlockValidateNode
from nodes.reporting.definition_persist_node import DefinitionPersistNode
from nodes.reporting.evaluate_conditions_node import EvaluateConditionsNode
from nodes.reporting.formatting import (
    EM_DASH_HTML,
    EUR_HTML,
    NBSP,
    format_value,
    list_formatters,
)
from nodes.reporting.load_definitions_node import LoadDefinitionsNode
from nodes.reporting.narrative_generation_node import (
    NarrativeGenerationNode,
    NarrativeReport,
)
from nodes.reporting.sql_batch_node import (
    BlockRunReport,
    ReportSqlBatchNode,
)
from nodes.reporting.sql_helpers import (
    VALID_BLOCK_KINDS,
    BlockValidationReport,
    IncludeError,
    ParsedFieldSql,
    expand_includes,
    field_param_names,
    parse_sql,
    validate_block,
    validate_blocks,
)
from nodes.reporting.template_render_node import (
    RenderContext,
    TemplateRenderNode,
    render_template,
)
from nodes.reporting.template_scan_node import (
    BlockDescriptor,
    ChartArrayDescriptor,
    ConditionDescriptor,
    NarrativeDescriptor,
    OrphanMarker,
    ScalarDescriptor,
    ScanResult,
    SectionDescriptor,
    TemplateScanError,
    TemplateScanNode,
    scan_template,
)

__all__ = [
    # template parsing
    "TemplateScanNode",
    "TemplateScanError",
    "scan_template",
    "ScanResult",
    "BlockDescriptor",
    "OrphanMarker",
    "SectionDescriptor",
    "ConditionDescriptor",
    "NarrativeDescriptor",
    "ChartArrayDescriptor",
    "ScalarDescriptor",
    # rendering
    "TemplateRenderNode",
    "render_template",
    "RenderContext",
    "format_value",
    "list_formatters",
    "NBSP",
    "EM_DASH_HTML",
    "EUR_HTML",
    # block-based pipeline
    "BlockDraftNode",
    "BlockDraftReport",
    "BlockValidateNode",
    "BlockValidationReport",
    "VALID_BLOCK_KINDS",
    "validate_block",
    "validate_blocks",
    "BlockRunReport",
    "ReportSqlBatchNode",
    "DefinitionPersistNode",
    "LoadDefinitionsNode",
    "EvaluateConditionsNode",
    "NarrativeGenerationNode",
    "NarrativeReport",
    # SQL helpers (used by validators + tools)
    "ParsedFieldSql",
    "IncludeError",
    "expand_includes",
    "field_param_names",
    "parse_sql",
]
