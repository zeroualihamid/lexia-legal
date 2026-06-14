"""TemplateRenderNode — turn a parsed template + computed data into HTML.

The renderer is **dumb on purpose**: it walks the template using the offsets
captured by ``template_scan_node`` and substitutes pre-computed values.  All
SQL execution, narrative generation and conditional evaluation happens
upstream; this node never calls the LLM and never opens DuckDB.

Render rules (applied in this order via a single recursive walk):

1. ``<!-- IF:flag --> … <!-- ENDIF:flag -->`` — keep the inner content if
   ``flags[flag]`` is truthy, otherwise drop the whole block (markers + body).
2. ``<!-- BEGIN:section --> … <!-- END:section -->`` — repeat the inner
   content once per row in ``sections[section]``.  Per-row values shadow the
   surrounding scalar context, so ``{{LINE_LABEL}}`` resolves against the
   row's columns.  Nested sections (``BEGIN:cells`` inside
   ``BEGIN:monthly_charge_rows``) read their data from the row dict
   under the child section's name (e.g. ``row["cells"]``).
3. ``[ /* {{TOKEN}} … */ ]`` (chart array) — replace the entire bracketed
   comment with a JSON array literal computed from
   ``chart_arrays[TOKEN]``.
4. ``/* {{TOKEN}} … */`` (chart-scalar comment, no surrounding brackets) —
   replace the whole comment with the formatted scalar value.  This is what
   makes ``money.format(/* {{TOTAL_CHARGES}} */)`` produce valid JS
   (``money.format(307432)``).
5. ``<!-- NARRATIVE:slot -->`` — replace with ``narratives[slot]`` (already
   prose, paragraph-wrapped by the caller).
6. ``{{TOKEN}}`` — finally, plain scalar substitution.

Post-passes (after the recursive walk):

* ``render_empty_blocks`` — inject ``kind=empty`` SQL cells into ``data-block``
  regions with no DSL markers (same inner-text strategy as below).
* ``render_data_block_scalars`` — for ``kind=scalar`` blocks, inject the primary
  token's value into matching ``data-block`` elements **only when** the original
  template inner HTML contained no ``{{TOKEN}}`` (otherwise the walk above is
  authoritative).

Shared-state contract
─────────────────────
Inputs:
    template_scan        (ScanResult)         — from template_scan_node.
    render_scalars       (dict[str, Any])     — raw values per scalar id.
    render_sections      (dict[str, list[dict]]) — rows per section id.
    render_flags         (dict[str, bool])    — boolean flags for IF blocks.
    render_narratives    (dict[str, str])     — pre-generated prose per slot.
    render_chart_arrays  (dict[str, list])    — JSON-serializable arrays.
    render_formats       (dict[str, str])     — optional ``field_id → format_name``.
    render_empty_blocks  (dict[str, Any])     — ``kind=empty`` SQL cell values.
    render_data_block_scalars (dict[str, tuple[str, Any]]) — optional
        ``data-block`` id → ``(token_name, raw_value)`` for scalar blocks whose
        HTML region had no placeholders.

Outputs:
    rendered_html        (str)
    rendered_missing     (list[str])          — field ids not supplied / set to ``None``.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from nodes.base_node import BaseNode
from nodes.reporting.formatting import EM_DASH_HTML, format_value
from nodes.reporting.template_scan_node import (
    ChartArrayDescriptor,
    ConditionDescriptor,
    NarrativeDescriptor,
    ScanResult,
    SectionDescriptor,
    _RE_CHART_SCALAR,
    _RE_TOKEN,
    _Span,
)


# ── Render context ──────────────────────────────────────────────────────────


@dataclass
class RenderContext:
    """Mutable per-render state passed down the recursive walk."""
    scan:         ScanResult
    scalars:      Dict[str, Any]
    sections:     Dict[str, List[Dict[str, Any]]]
    flags:        Dict[str, bool]
    narratives:   Dict[str, str]
    chart_arrays: Dict[str, Any]
    formats:      Dict[str, str]
    missing:      List[str] = field(default_factory=list)

    # ── Lookup helpers, with single-source-of-truth missing tracking ────────

    def scalar(self, name: str) -> str:
        if name not in self.scalars:
            if name not in self.missing:
                self.missing.append(name)
            return EM_DASH_HTML
        return format_value(self.scalars[name], self.formats.get(name, "passthrough"))

    def narrative(self, name: str) -> str:
        slot = f"NARRATIVE:{name}"
        text = self.narratives.get(name)
        if text is None:
            text = self.narratives.get(slot)
        if text is None:
            if slot not in self.missing:
                self.missing.append(slot)
            return ""
        return str(text)

    def chart_array(self, name: str) -> str:
        if name not in self.chart_arrays:
            if name not in self.missing:
                self.missing.append(name)
            return "[]"
        value = self.chart_arrays[name]
        if not isinstance(value, list):
            value = list(value)
        return json.dumps(value, ensure_ascii=False)

    # ── Per-row context push (immutable copy to isolate iterations) ─────────

    def with_row(self, row: Dict[str, Any]) -> "RenderContext":
        new_scalars  = dict(self.scalars)
        new_sections = dict(self.sections)
        for k, v in row.items():
            if isinstance(v, list):
                new_sections[k] = v
            else:
                new_scalars[k] = v
        return RenderContext(
            scan         = self.scan,
            scalars      = new_scalars,
            sections     = new_sections,
            flags        = self.flags,
            narratives   = self.narratives,
            chart_arrays = self.chart_arrays,
            formats      = self.formats,
            missing      = self.missing,
        )


# ── Section / condition lookup tables ───────────────────────────────────────


def _index_by_name(scan: ScanResult) -> Tuple[
    Dict[str, SectionDescriptor],
    Dict[str, ConditionDescriptor],
    Dict[str, NarrativeDescriptor],
    Dict[str, ChartArrayDescriptor],
]:
    return (
        {s.name: s for s in scan.sections},
        {c.name: c for c in scan.conditions},
        {n.name: n for n in scan.narratives},
        {c.name: c for c in scan.chart_arrays},
    )


# ── Render events ──────────────────────────────────────────────────────────


@dataclass
class _Event:
    start: int
    end:   int
    kind:  str  # "BEGIN" | "IF" | "NARRATIVE" | "CHART_ARRAY" | "CHART_SCALAR" | "SCALAR"
    name:  str
    span:  _Span
    end_span: Optional[_Span] = None  # for BEGIN/IF, span of matching END/ENDIF

    @property
    def block_end(self) -> int:
        """Offset just after the closing marker (or after self for atoms)."""
        return self.end_span.end if self.end_span is not None else self.end


def _build_top_level_events(
    scan: ScanResult,
    section_by_name: Dict[str, SectionDescriptor],
    condition_by_name: Dict[str, ConditionDescriptor],
    region_start: int,
    region_end: int,
    current_section_name: Optional[str],
) -> List[_Event]:
    """Collect render events that start inside [region_start, region_end) and
    are *immediate* children of the current render frame — meaning they are
    not nested inside any other section/condition event at this level.

    ``current_section_name`` is the name of the section we're rendering
    (None at top-level).  A section becomes an event here only when its
    ``parent`` equals ``current_section_name``; otherwise it is either a
    deeper grand-child (handled recursively when its parent renders) or a
    sibling at a different depth (out of scope here).
    """
    events: List[_Event] = []

    for sec in scan.sections:
        if sec.begin_marker.start < region_start or sec.end_marker.end > region_end:
            continue
        if sec.parent != current_section_name:
            continue
        events.append(_Event(
            start    = sec.begin_marker.start,
            end      = sec.begin_marker.end,
            kind     = "BEGIN",
            name     = sec.name,
            span     = sec.begin_marker,
            end_span = sec.end_marker,
        ))

    # IF blocks are independent of section nesting.
    for cond in scan.conditions:
        if cond.begin_marker.start < region_start or cond.end_marker.end > region_end:
            continue
        events.append(_Event(
            start    = cond.begin_marker.start,
            end      = cond.begin_marker.end,
            kind     = "IF",
            name     = cond.name,
            span     = cond.begin_marker,
            end_span = cond.end_marker,
        ))

    # Narratives, chart arrays — atomic.
    for n in scan.narratives:
        if region_start <= n.marker.start and n.marker.end <= region_end:
            events.append(_Event(
                start = n.marker.start,
                end   = n.marker.end,
                kind  = "NARRATIVE",
                name  = n.name,
                span  = n.marker,
            ))
    for c in scan.chart_arrays:
        if region_start <= c.marker.start and c.marker.end <= region_end:
            events.append(_Event(
                start = c.marker.start,
                end   = c.marker.end,
                kind  = "CHART_ARRAY",
                name  = c.name,
                span  = c.marker,
            ))

    # Sort and prune events fully contained within an earlier event's block.
    events.sort(key=lambda e: e.start)
    pruned: List[_Event] = []
    cursor = region_start
    for ev in events:
        if ev.start < cursor:
            continue
        pruned.append(ev)
        cursor = ev.block_end
    return pruned


# ── Recursive walk ──────────────────────────────────────────────────────────


def _emit_text(html: str, start: int, end: int, ctx: RenderContext) -> str:
    """Substitute chart-scalar comments and plain ``{{TOKEN}}`` in a leaf chunk
    of HTML.  Chart arrays and bracketed JS-array placeholders are NEVER
    handled here — they're top-level events processed by the walker."""
    fragment = html[start:end]

    # Chart-scalar comments first: ``/* {{X}} … */`` → formatted value (whole
    # comment goes away, including the surrounding ``/* */``).
    def _chart_scalar_repl(m):
        return ctx.scalar(m.group(1))
    fragment = _RE_CHART_SCALAR.sub(_chart_scalar_repl, fragment)

    # Plain scalars.
    def _scalar_repl(m):
        return ctx.scalar(m.group(1))
    fragment = _RE_TOKEN.sub(_scalar_repl, fragment)

    return fragment


def _render_range(
    html: str,
    region_start: int,
    region_end:   int,
    ctx:          RenderContext,
    section_by_name: Dict[str, SectionDescriptor],
    current_section_name: Optional[str],
) -> str:
    out: List[str] = []
    events = _build_top_level_events(
        ctx.scan, section_by_name, {c.name: c for c in ctx.scan.conditions},
        region_start, region_end, current_section_name,
    )

    cursor = region_start
    for ev in events:
        if ev.start > cursor:
            out.append(_emit_text(html, cursor, ev.start, ctx))

        if ev.kind == "BEGIN":
            sec = section_by_name[ev.name]
            out.append(_render_section(html, sec, ctx, section_by_name))
            cursor = ev.end_span.end
        elif ev.kind == "IF":
            cond = next(c for c in ctx.scan.conditions if c.name == ev.name)
            if ctx.flags.get(ev.name, False):
                out.append(_render_range(
                    html,
                    cond.inner.start, cond.inner.end,
                    ctx, section_by_name, current_section_name,
                ))
            cursor = ev.end_span.end
        elif ev.kind == "NARRATIVE":
            out.append(ctx.narrative(ev.name))
            cursor = ev.end
        elif ev.kind == "CHART_ARRAY":
            out.append(ctx.chart_array(ev.name))
            cursor = ev.end

    if cursor < region_end:
        out.append(_emit_text(html, cursor, region_end, ctx))

    return "".join(out)


def _render_section(
    html: str,
    section: SectionDescriptor,
    ctx: RenderContext,
    section_by_name: Dict[str, SectionDescriptor],
) -> str:
    rows = ctx.sections.get(section.name)
    if rows is None:
        if section.name not in ctx.missing:
            ctx.missing.append(section.name)
        return ""
    if not rows:
        return ""

    parts: List[str] = []
    for row in rows:
        sub_ctx = ctx.with_row(row)
        parts.append(_render_range(
            html,
            section.inner.start, section.inner.end,
            sub_ctx, section_by_name,
            current_section_name=section.name,
        ))
    return "".join(parts)


# ── Public API ──────────────────────────────────────────────────────────────


def render_template(
    scan: ScanResult,
    *,
    scalars:      Optional[Dict[str, Any]]               = None,
    sections:     Optional[Dict[str, List[Dict[str, Any]]]] = None,
    flags:        Optional[Dict[str, bool]]              = None,
    narratives:   Optional[Dict[str, str]]               = None,
    chart_arrays: Optional[Dict[str, Any]]               = None,
    empty_blocks: Optional[Dict[str, Any]]               = None,
    data_block_scalars: Optional[Dict[str, Tuple[str, Any]]] = None,
    formats:      Optional[Dict[str, str]]               = None,
) -> Tuple[str, List[str]]:
    """Render the parsed template into final HTML.

    Returns a tuple ``(html, missing)`` where ``missing`` is the list of
    field ids that were referenced by the template but not supplied (helps
    the agent surface gaps).
    """
    ctx = RenderContext(
        scan         = scan,
        scalars      = dict(scalars or {}),
        sections     = dict(sections or {}),
        flags        = dict(flags or {}),
        narratives   = dict(narratives or {}),
        chart_arrays = dict(chart_arrays or {}),
        formats      = dict(formats or {}),
    )

    section_by_name, _, _, _ = _index_by_name(scan)

    html = _render_range(
        scan.template_html,
        0, len(scan.template_html),
        ctx, section_by_name,
        current_section_name=None,
    )
    html = _apply_empty_block_replacements(html, empty_blocks or {})
    html = _apply_data_block_scalar_injections(
        html, scan, data_block_scalars or {}, formats or {},
    )
    return html, ctx.missing


def _apply_empty_block_replacements(
    html: str,
    empty_blocks: Dict[str, Any],
) -> str:
    """Inject SQL results into executable ``kind=empty`` data-block elements.

    These blocks have no DSL token inside the template, so plain scalar
    substitution cannot reach them. We replace the first visible text segment
    inside the matching ``data-block`` while preserving any nested markup
    (e.g. unit ``<span>`` children).
    """
    if not html or not empty_blocks:
        return html

    def replace_inner_text(inner_html: str, rendered_value: str) -> str:
        match = re.search(r"(?P<lead>\s*)(?P<text>[^<\s][^<]*?)(?P<trail>\s*)(?=<|$)", inner_html, re.DOTALL)
        if not match:
            return f"{rendered_value}{inner_html}"
        return (
            inner_html[:match.start()]
            + match.group("lead")
            + rendered_value
            + match.group("trail")
            + inner_html[match.end():]
        )

    out = html
    for block_id, raw_value in empty_blocks.items():
        replacement = format_value(raw_value, "passthrough") if raw_value is not None else EM_DASH_HTML
        pattern = re.compile(
            rf"(?P<open><(?P<tag>[A-Za-z][A-Za-z0-9:-]*)(?P<attrs>[^>]*\bdata-block\s*=\s*[\"']){re.escape(block_id)}([\"'][^>]*)>)(?P<inner>.*?)(?P<close></(?P=tag)>)",
            re.IGNORECASE | re.DOTALL,
        )

        def _repl(match: "re.Match[str]") -> str:
            open_tag = match.group("open")
            inner = match.group("inner")
            close_tag = match.group("close")
            return open_tag + replace_inner_text(inner, replacement) + close_tag

        out, _count = pattern.subn(_repl, out, count=1)
    return out


def _apply_data_block_scalar_injections(
    html: str,
    scan: ScanResult,
    data_block_scalars: Dict[str, Tuple[str, Any]],
    formats: Dict[str, str],
) -> str:
    """Inject ``kind=scalar`` SQL results into ``data-block`` regions that had no
    ``{{TOKEN}}`` in the source template (placeholder copy only).

    Skips a block when the original inner HTML already contained ``{{…}}`` so
    the main walk's substitution is authoritative.

    Replaces the **first numeric-looking segment** in the block inner HTML
    (mock KPI values such as ``266,7`` or ``6 007,2``). Rich templates should
    prefer explicit ``{{TOKEN}}`` markers instead.
    """
    if not html or not data_block_scalars:
        return html

    # First segment that looks like a formatted quantity / mock number.
    _RE_FIRST_NUMBER_RUN = re.compile(
        r"\d(?:[\d\s\u00a0]*[,.]\d+|[\d\s\u00a0]{0,16}\d)",
    )

    def replace_inner_numeric(inner_html: str, rendered_value: str) -> str:
        m = _RE_FIRST_NUMBER_RUN.search(inner_html)
        if not m:
            return f"{rendered_value}{inner_html}"
        return inner_html[: m.start()] + rendered_value + inner_html[m.end() :]

    template_html = scan.template_html
    out = html
    for block_id, pair in data_block_scalars.items():
        token_name, raw_value = pair
        bd = next((b for b in scan.blocks if b.name == block_id), None)
        if bd is not None:
            inner_orig = template_html[bd.inner_span.start : bd.inner_span.end]
            if _RE_TOKEN.search(inner_orig):
                continue
        replacement = (
            format_value(raw_value, formats.get(token_name, "passthrough"))
            if raw_value is not None
            else EM_DASH_HTML
        )
        pattern = re.compile(
            rf"(?P<open><(?P<tag>[A-Za-z][A-Za-z0-9:-]*)(?P<attrs>[^>]*\bdata-block\s*=\s*[\"']){re.escape(block_id)}([\"'][^>]*)>)(?P<inner>.*?)(?P<close></(?P=tag)>)",
            re.IGNORECASE | re.DOTALL,
        )

        def _repl(match: "re.Match[str]") -> str:
            open_tag = match.group("open")
            inner = match.group("inner")
            close_tag = match.group("close")
            return open_tag + replace_inner_numeric(inner, replacement) + close_tag

        out, _count = pattern.subn(_repl, out, count=1)
    return out


# ── PocketFlow node wrapper ─────────────────────────────────────────────────


class TemplateRenderNode(BaseNode):
    """Render the scanned template using values supplied via shared state."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "TemplateRender")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)
        scan = shared.get("template_scan")
        if scan is None:
            raise ValueError(
                "TemplateRenderNode requires 'template_scan' (run TemplateScanNode first)"
            )
        return {
            "scan":         scan,
            "scalars":      shared.get("render_scalars",      {}),
            "sections":     shared.get("render_sections",     {}),
            "flags":        shared.get("render_flags",        {}),
            "narratives":   shared.get("render_narratives",   {}),
            "chart_arrays": shared.get("render_chart_arrays", {}),
            "empty_blocks": shared.get("render_empty_blocks", {}),
            "data_block_scalars": shared.get("render_data_block_scalars", {}),
            "formats":      shared.get("render_formats",      {}),
        }

    def exec(self, prep_result: Dict[str, Any]) -> Tuple[str, List[str]]:
        return render_template(
            prep_result["scan"],
            scalars      = prep_result["scalars"],
            sections     = prep_result["sections"],
            flags        = prep_result["flags"],
            narratives   = prep_result["narratives"],
            chart_arrays = prep_result["chart_arrays"],
            empty_blocks = prep_result["empty_blocks"],
            data_block_scalars = prep_result["data_block_scalars"],
            formats      = prep_result["formats"],
        )

    def post(self, shared: Dict[str, Any], prep_result: Any, exec_result: Tuple[str, List[str]]) -> str:
        html, missing = exec_result
        shared["rendered_html"]    = html
        shared["rendered_missing"] = missing
        if missing:
            self.logger.warning(
                "Render completed with %d missing field(s): %s",
                len(missing), missing[:10],
            )
        self.log_exit("default")
        return "default"
