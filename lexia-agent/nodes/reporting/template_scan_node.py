"""TemplateScanNode — pure parser for the reporting HTML DSL.

The single source of truth is each template's ``report-template.html``. The
DSL has four token kinds:

1. **Scalar token** — ``{{KEY}}`` (single-value substitution).
2. **Repeating block** — ``<!-- BEGIN:name --> … <!-- END:name -->``
   (rows of a result-set, may nest, e.g. ``monthly_charge_rows`` → ``cells``).
3. **Conditional flag** — ``<!-- IF:flag --> … <!-- ENDIF:flag -->``
   (boolean wrap).
4. **Narrative slot** — ``<!-- NARRATIVE:name -->`` (LLM-generated prose).

Plus a special **chart-array** form: ``var X = [/* {{TOKEN}} … */];`` —
the renderer must replace the entire ``[/* … */]`` body with a JSON array
literal, not naively substitute the comment.

This module is pure (no LLM, no IO besides reading the file) and feeds:
- ``definition_draft_node``      → drafts a CTE per scanned token.
- ``template_render_node``       → uses the same offsets to paste data back.
- ``definition_persist_node``    → diffs scanned tokens against the YAML.

Shared-state contract
─────────────────────
Inputs (via ``shared``):
    template_path  (str | Path)  — absolute path to ``report-template.html``,
                                   OR ``template_html`` (str) for in-memory.

Outputs (via ``shared``):
    template_scan  (ScanResult)  — structured token inventory.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from nodes.base_node import BaseNode


# ── Regex patterns ──────────────────────────────────────────────────────────
#
# Comments are matched non-greedily up to the first ``-->``. Token names are
# ASCII letters or underscores (definitions commonly use lowercase snake_case).

_TOKEN_NAME = r"[A-Za-z][A-Za-z0-9_]*"
_BLOCK_NAME = r"[A-Za-z_][A-Za-z0-9_]*"

_RE_BEGIN     = re.compile(rf"<!--\s*BEGIN:({_BLOCK_NAME}).*?-->", re.DOTALL)
_RE_END       = re.compile(rf"<!--\s*END:({_BLOCK_NAME}).*?-->",   re.DOTALL)
_RE_IF        = re.compile(rf"<!--\s*IF:({_BLOCK_NAME}).*?-->",    re.DOTALL)
_RE_ENDIF     = re.compile(rf"<!--\s*ENDIF:({_BLOCK_NAME}).*?-->", re.DOTALL)
_RE_NARRATIVE = re.compile(rf"<!--\s*NARRATIVE:({_BLOCK_NAME}).*?-->", re.DOTALL)
_RE_TOKEN     = re.compile(rf"\{{\{{({_TOKEN_NAME})\}}\}}")

# ── data-block (block-level marker) regexes ─────────────────────────────────
#
# A *block* is any HTML element carrying a ``data-block="<name>"`` attribute.
# The scanner pairs the opening tag with its matching closing tag using a
# lightweight stack walker (HTMLParser is overkill here and doesn't expose
# byte offsets).  We support every standard HTML element; void elements
# (``<br>``, ``<img>``, …) are simply not pushed on the stack.

_RE_HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
_RE_OPEN_TAG  = re.compile(
    r"<([A-Za-z][A-Za-z0-9]*)(\s[^>]*)?>",
    re.DOTALL,
)
_RE_CLOSE_TAG = re.compile(r"</([A-Za-z][A-Za-z0-9]*)\s*>")
_RE_DATA_BLOCK_ATTR = re.compile(
    r'\bdata-block\s*=\s*(?:"([^"]+)"|\'([^\']+)\')'
)

# HTML5 void elements: open tag exists, no closing tag.
_VOID_ELEMENTS = frozenset({
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "source", "track", "wbr",
})

# A chart array is ``[/* {{TOKEN}} … */]`` — the renderer replaces the whole
# bracket-comment with a JSON array. Multi-line capable.
_RE_CHART_ARRAY = re.compile(
    rf"\[\s*/\*\s*\{{\{{({_TOKEN_NAME})\}}\}}.*?\*/\s*\]",
    re.DOTALL,
)
# A chart scalar is ``/* {{TOKEN}} … */`` (no surrounding brackets) — the
# renderer replaces the whole ``/* … */`` with the formatted scalar value
# (instead of leaving it as a JS comment). Used for in-function references
# like ``money.format(/* {{TOTAL_CHARGES}} */)``.
_RE_CHART_SCALAR = re.compile(
    rf"/\*\s*\{{\{{({_TOKEN_NAME})\}}\}}.*?\*/",
    re.DOTALL,
)


# ── Result data classes ─────────────────────────────────────────────────────


@dataclass
class _Span:
    """[start, end) byte/char offsets in the source template."""
    start: int
    end:   int


@dataclass
class SectionDescriptor:
    """``<!-- BEGIN:name --> … <!-- END:name -->`` block."""
    name:          str
    parent:        Optional[str]
    begin_marker:  _Span      # span of the BEGIN comment itself
    end_marker:    _Span      # span of the END comment itself
    inner:         _Span      # span of the content between begin_marker.end and end_marker.start
    inner_tokens:  List[str]  # ``{{TOKEN}}`` names found INSIDE inner, EXCLUDING tokens of nested sections
    children:      List[str] = field(default_factory=list)  # names of immediate child sections
    line:          int = 0


@dataclass
class ConditionDescriptor:
    """``<!-- IF:flag --> … <!-- ENDIF:flag -->`` block."""
    name:         str
    begin_marker: _Span
    end_marker:   _Span
    inner:        _Span
    line:         int = 0


@dataclass
class NarrativeDescriptor:
    """``<!-- NARRATIVE:name -->`` slot."""
    name:    str
    marker:  _Span
    line:    int = 0


@dataclass
class ChartArrayDescriptor:
    """``[/* {{TOKEN}} … */]`` JS-array placeholder."""
    name:    str
    marker:  _Span      # span of the entire ``[ … ]`` (including brackets)
    line:    int = 0


@dataclass
class ScalarDescriptor:
    """``{{TOKEN}}`` token outside any section / chart array.

    Multiple occurrences are merged under one descriptor — the renderer
    just performs textual substitution everywhere the token appears.
    """
    name:        str
    occurrences: List[_Span] = field(default_factory=list)
    in_chart_scalar_comment: bool = False  # True if any occurrence is inside ``/* {{X}} */``
    lines:       List[int] = field(default_factory=list)


@dataclass
class BlockDescriptor:
    """A ``<element data-block="<name>">…</element>`` region in the template.

    Every DSL marker (`{{TOKEN}}`, `BEGIN/END:section`, `IF/ENDIF:flag`,
    `NARRATIVE:name`, chart-array placeholder) whose offset falls inside
    ``inner_span`` is *owned* by the closest-ancestor block (innermost
    wins for nested blocks).  Markers without any ancestor block surface
    as :class:`OrphanMarker`.

    The block's ``kind`` is inferred from the inner DSL inventory
    (see :data:`SCHEMA.md`):

    * only scalars                      → ``scalar``
    * exactly one section, no scalars   → ``section``
    * exactly one condition, no scalars → ``condition``
    * exactly one narrative, no scalars → ``narrative``
    * everything else                   → ``mixed``
    * empty (no DSL inside)             → ``empty`` (skipped by validator)
    """
    name:               str
    element:            str
    open_span:          _Span
    close_span:         _Span
    inner_span:         _Span
    line:               int = 0
    kind:               str = "empty"

    inner_scalars:      List[str] = field(default_factory=list)
    inner_sections:     List[str] = field(default_factory=list)
    inner_conditions:   List[str] = field(default_factory=list)
    inner_narratives:   List[str] = field(default_factory=list)
    inner_chart_arrays: List[str] = field(default_factory=list)

    html_excerpt:       str = ""


@dataclass
class OrphanMarker:
    """A DSL marker whose offset is not inside any tagged ``data-block`` div."""
    kind: str        # "scalar" | "section" | "condition" | "narrative" | "chart_array"
    name: str
    line: int = 0


@dataclass
class ScanResult:
    """Structured inventory produced by :func:`scan_template`."""
    scalars:      List[ScalarDescriptor]
    sections:     List[SectionDescriptor]
    conditions:   List[ConditionDescriptor]
    narratives:   List[NarrativeDescriptor]
    chart_arrays: List[ChartArrayDescriptor]
    template_html: str
    blocks:       List[BlockDescriptor]     = field(default_factory=list)
    orphans:      List[OrphanMarker]        = field(default_factory=list)

    # Convenience: every distinct token name that needs a definition entry.
    @property
    def all_field_ids(self) -> List[str]:
        ids: List[str] = []
        seen: set = set()

        def _push(token: str) -> None:
            if token not in seen:
                seen.add(token)
                ids.append(token)

        for s in self.scalars:
            _push(s.name)
        for sec in self.sections:
            _push(sec.name)
        for c in self.conditions:
            _push(c.name)
        for n in self.narratives:
            _push(f"NARRATIVE:{n.name}")
        for ch in self.chart_arrays:
            _push(ch.name)
        return ids

    @property
    def all_block_ids(self) -> List[str]:
        """Every distinct ``data-block`` name in source order."""
        seen: set = set()
        out: List[str] = []
        for b in self.blocks:
            if b.name not in seen:
                seen.add(b.name)
                out.append(b.name)
        return out

    def to_dict(self) -> Dict[str, Any]:
        """JSON-serialisable form for SSE / API responses."""
        return {
            "scalars": [
                {
                    "name": s.name,
                    "occurrences": len(s.occurrences),
                    "in_chart_scalar_comment": s.in_chart_scalar_comment,
                    "lines": s.lines,
                }
                for s in self.scalars
            ],
            "sections": [
                {
                    "name": sec.name,
                    "parent": sec.parent,
                    "children": list(sec.children),
                    "inner_tokens": list(sec.inner_tokens),
                    "line": sec.line,
                }
                for sec in self.sections
            ],
            "conditions": [
                {"name": c.name, "line": c.line} for c in self.conditions
            ],
            "narratives": [
                {"name": n.name, "line": n.line} for n in self.narratives
            ],
            "chart_arrays": [
                {"name": c.name, "line": c.line} for c in self.chart_arrays
            ],
            "blocks": [
                {
                    "name":               b.name,
                    "element":            b.element,
                    "kind":               b.kind,
                    "line":               b.line,
                    "inner_scalars":      list(b.inner_scalars),
                    "inner_sections":     list(b.inner_sections),
                    "inner_conditions":   list(b.inner_conditions),
                    "inner_narratives":   list(b.inner_narratives),
                    "inner_chart_arrays": list(b.inner_chart_arrays),
                    "html_excerpt":       b.html_excerpt,
                }
                for b in self.blocks
            ],
            "orphans": [
                {"kind": o.kind, "name": o.name, "line": o.line}
                for o in self.orphans
            ],
        }


# ── Scanner implementation ──────────────────────────────────────────────────


class TemplateScanError(ValueError):
    """Raised when BEGIN/END or IF/ENDIF markers are unbalanced."""


def _line_of(html: str, offset: int) -> int:
    return html.count("\n", 0, offset) + 1


def _ranges_overlap(point: int, ranges: List[Tuple[int, int]]) -> bool:
    for rs, re_ in ranges:
        if rs <= point < re_:
            return True
    return False


def _find_blocks(
    html: str,
    comment_ranges: List[Tuple[int, int]],
) -> List[BlockDescriptor]:
    """Pair every ``<element data-block="<name>">`` with its closing tag.

    A small left-to-right stack walker handles nested ``<div>``s correctly
    and ignores any ``<>`` matches that fall inside HTML comments.  Void
    elements (``<br>``, ``<img>``, …) are recognised and not pushed on
    the stack so they don't break the matching of surrounding open/close
    tags.

    The walker is intentionally tolerant: when an unmatched closing tag
    is encountered we pop the stack until we find a match (or the stack
    empties).  This keeps the scanner working on real-world HTML that
    occasionally embeds JS strings containing ``<…>`` patterns.
    """
    Event = Tuple[int, str, str, str, int]   # (offset, kind, tag, attrs, end)
    events: List[Event] = []

    for m in _RE_OPEN_TAG.finditer(html):
        if _ranges_overlap(m.start(), comment_ranges):
            continue
        tag = m.group(1).lower()
        attrs = m.group(2) or ""
        events.append((m.start(), "open", tag, attrs, m.end()))

    for m in _RE_CLOSE_TAG.finditer(html):
        if _ranges_overlap(m.start(), comment_ranges):
            continue
        events.append((m.start(), "close", m.group(1).lower(), "", m.end()))

    events.sort(key=lambda e: e[0])

    stack: List[Dict[str, Any]] = []
    blocks: List[BlockDescriptor] = []

    for offset, evt_kind, tag, attrs, end in events:
        if evt_kind == "open":
            # Self-closing ("/>") and HTML5 void elements never push.
            self_closing = attrs.rstrip().endswith("/")
            if tag in _VOID_ELEMENTS or self_closing:
                # We still record the data-block (extremely unusual for void
                # elements, but tolerate it) by emitting a zero-length
                # block — doesn't really make sense, so just skip.
                continue
            m_attr = _RE_DATA_BLOCK_ATTR.search(attrs)
            data_block_name = (
                m_attr.group(1) or m_attr.group(2)
                if m_attr is not None else None
            )
            stack.append({
                "tag":             tag,
                "open_start":      offset,
                "open_end":        end,
                "data_block_name": data_block_name,
            })
        else:                                            # close
            # Pop any unmatched opens above the matching tag.
            while stack and stack[-1]["tag"] != tag:
                stack.pop()
            if not stack:
                continue
            top = stack.pop()
            if top["data_block_name"]:
                open_span  = _Span(top["open_start"], top["open_end"])
                close_span = _Span(offset, end)
                inner_span = _Span(top["open_end"], offset)
                excerpt    = html[top["open_start"]:end]
                if len(excerpt) > 4000:
                    excerpt = excerpt[:4000] + "\n…[truncated]"
                blocks.append(BlockDescriptor(
                    name       = top["data_block_name"],
                    element    = top["tag"],
                    open_span  = open_span,
                    close_span = close_span,
                    inner_span = inner_span,
                    line       = _line_of(html, top["open_start"]),
                    html_excerpt = excerpt,
                ))

    # Stable order: by source offset.
    blocks.sort(key=lambda b: b.open_span.start)
    return blocks


def _innermost_block(
    offset: int,
    blocks: List[BlockDescriptor],
) -> Optional[BlockDescriptor]:
    """Return the deepest block whose full domain contains *offset*.

    A block's *domain* spans from the start of its opening tag to the end
    of its closing tag — not just ``inner_span`` — so tokens embedded in
    attribute values (e.g. ``class="score-{{SCORE_LEVEL}}"``) are
    correctly attributed to the block carrying ``data-block="…"``.
    """
    best: Optional[BlockDescriptor] = None
    for b in blocks:
        if b.open_span.start <= offset < b.close_span.end:
            if best is None or b.open_span.start > best.open_span.start:
                best = b
    return best


def _infer_block_kind(b: BlockDescriptor) -> str:
    """Map a block's inner DSL inventory to its ``kind``.

    The contract documented in ``data/reporting/SCHEMA.md`` is:

      * only scalars                      → ``scalar``
      * exactly one section, no scalars   → ``section``
      * exactly one condition, no scalars → ``condition``
      * exactly one narrative, no scalars → ``narrative``
      * any combination (incl. chart_arrays mixed with scalars)
                                          → ``mixed``
      * truly empty (no DSL inside)       → ``empty``
    """
    n_scalar    = len(b.inner_scalars)
    n_section   = len(b.inner_sections)
    n_condition = len(b.inner_conditions)
    n_narrative = len(b.inner_narratives)
    n_chart     = len(b.inner_chart_arrays)
    total = n_scalar + n_section + n_condition + n_narrative + n_chart

    if total == 0:
        return "empty"
    if n_scalar == total:
        return "scalar"
    if n_chart == total:
        return "chart_array"
    if n_section == total == 1:
        return "section"
    if n_condition == total == 1:
        return "condition"
    if n_narrative == total == 1:
        return "narrative"
    return "mixed"


def scan_template(html: str) -> ScanResult:
    """Parse a reporting HTML template into a :class:`ScanResult`.

    The function is deterministic: identical inputs yield identical outputs,
    which makes it safe to call from validators, the bootstrap flow, and the
    edit agent's tools alike.
    """
    if not html:
        raise TemplateScanError("Empty template — nothing to scan")

    # ── 1. Find chart arrays — these *exclude* their inner ``{{TOKEN}}`` from
    #      scalar / section detection because they obey a different render rule.
    chart_arrays: List[ChartArrayDescriptor] = []
    chart_array_ranges: List[Tuple[int, int]] = []
    for m in _RE_CHART_ARRAY.finditer(html):
        chart_arrays.append(ChartArrayDescriptor(
            name   = m.group(1),
            marker = _Span(m.start(), m.end()),
            line   = _line_of(html, m.start()),
        ))
        chart_array_ranges.append((m.start(), m.end()))

    # ── 2. Find chart-scalar comments (``/* {{X}} */`` not inside ``[ … ]``).
    #      We mark the inside ``{{X}}`` so the renderer replaces the whole
    #      comment, but we still treat them as scalars.
    chart_scalar_token_offsets: Dict[str, List[Tuple[int, int]]] = {}
    chart_scalar_outer_ranges: List[Tuple[int, int]] = []
    for m in _RE_CHART_SCALAR.finditer(html):
        if _ranges_overlap(m.start(), chart_array_ranges):
            continue
        token = m.group(1)
        chart_scalar_token_offsets.setdefault(token, []).append((m.start(), m.end()))
        chart_scalar_outer_ranges.append((m.start(), m.end()))

    # ── 3. Find narratives — independent of BEGIN/END / IF/ENDIF blocks.
    narratives: List[NarrativeDescriptor] = []
    seen_narrative: set = set()
    for m in _RE_NARRATIVE.finditer(html):
        name = m.group(1)
        narratives.append(NarrativeDescriptor(
            name   = name,
            marker = _Span(m.start(), m.end()),
            line   = _line_of(html, m.start()),
        ))
        seen_narrative.add(name)

    # ── 4. Pair BEGIN/END and IF/ENDIF using two interleaved stacks.
    markers: List[Tuple[int, str, str, int]] = []
    for m in _RE_BEGIN.finditer(html):
        markers.append((m.start(), "BEGIN",  m.group(1), m.end()))
    for m in _RE_END.finditer(html):
        markers.append((m.start(), "END",    m.group(1), m.end()))
    for m in _RE_IF.finditer(html):
        markers.append((m.start(), "IF",     m.group(1), m.end()))
    for m in _RE_ENDIF.finditer(html):
        markers.append((m.start(), "ENDIF",  m.group(1), m.end()))
    markers.sort(key=lambda t: t[0])

    section_stack: List[Dict[str, Any]] = []
    if_stack:      List[Dict[str, Any]] = []
    sections_raw:  List[Dict[str, Any]] = []
    conditions:    List[ConditionDescriptor] = []

    for start, kind, name, end in markers:
        if kind == "BEGIN":
            section_stack.append({
                "name":         name,
                "parent":       section_stack[-1]["name"] if section_stack else None,
                "begin_marker": _Span(start, end),
                "inner_start":  end,
            })
        elif kind == "END":
            if not section_stack:
                raise TemplateScanError(
                    f"Unmatched END:{name} at line {_line_of(html, start)}"
                )
            top = section_stack.pop()
            if top["name"] != name:
                raise TemplateScanError(
                    f"Mismatched END:{name} at line {_line_of(html, start)} "
                    f"(expected END:{top['name']})"
                )
            top["end_marker"] = _Span(start, end)
            top["inner"]      = _Span(top["inner_start"], start)
            sections_raw.append(top)
        elif kind == "IF":
            if_stack.append({
                "name":         name,
                "begin_marker": _Span(start, end),
                "inner_start":  end,
            })
        elif kind == "ENDIF":
            if not if_stack:
                raise TemplateScanError(
                    f"Unmatched ENDIF:{name} at line {_line_of(html, start)}"
                )
            top = if_stack.pop()
            if top["name"] != name:
                raise TemplateScanError(
                    f"Mismatched ENDIF:{name} at line {_line_of(html, start)} "
                    f"(expected ENDIF:{top['name']})"
                )
            conditions.append(ConditionDescriptor(
                name         = top["name"],
                begin_marker = top["begin_marker"],
                end_marker   = _Span(start, end),
                inner        = _Span(top["inner_start"], start),
                line         = _line_of(html, top["begin_marker"].start),
            ))

    if section_stack:
        raise TemplateScanError(
            "Unclosed sections: " + ", ".join(s["name"] for s in section_stack)
        )
    if if_stack:
        raise TemplateScanError(
            "Unclosed conditions: " + ", ".join(c["name"] for c in if_stack)
        )

    # ── 5. Build SectionDescriptor list in source order, with parent/child links
    #      and inner_tokens that exclude any nested-section tokens.
    sections_raw.sort(key=lambda s: s["begin_marker"].start)
    name_to_section: Dict[str, SectionDescriptor] = {}
    sections: List[SectionDescriptor] = []
    for s in sections_raw:
        sec = SectionDescriptor(
            name         = s["name"],
            parent       = s["parent"],
            begin_marker = s["begin_marker"],
            end_marker   = s["end_marker"],
            inner        = s["inner"],
            inner_tokens = [],
            children     = [],
            line         = _line_of(html, s["begin_marker"].start),
        )
        sections.append(sec)
        name_to_section[sec.name] = sec
    for sec in sections:
        if sec.parent and sec.parent in name_to_section:
            name_to_section[sec.parent].children.append(sec.name)

    # Compute inner_tokens for each section (excluding nested children ranges).
    for sec in sections:
        child_ranges = [
            (name_to_section[c].begin_marker.start, name_to_section[c].end_marker.end)
            for c in sec.children
        ]
        child_ranges.sort()
        # Knit together the parts of inner_text that aren't inside a child.
        pieces: List[str] = []
        cursor = sec.inner.start
        for cs, ce in child_ranges:
            if cursor < cs:
                pieces.append(html[cursor:cs])
            cursor = max(cursor, ce)
        pieces.append(html[cursor:sec.inner.end])
        inner_text = "".join(pieces)

        seen: set = set()
        for m in _RE_TOKEN.finditer(inner_text):
            tok = m.group(1)
            if tok not in seen:
                seen.add(tok)
                sec.inner_tokens.append(tok)

    # ── 6. Collect scalars: any ``{{TOKEN}}`` whose occurrence is NOT inside
    #      a section AND NOT inside a chart_array bracket comment.
    section_ranges = [(s.begin_marker.start, s.end_marker.end) for s in sections]
    excluded_ranges = sorted(chart_array_ranges + section_ranges)

    scalar_map: Dict[str, ScalarDescriptor] = {}
    for m in _RE_TOKEN.finditer(html):
        if _ranges_overlap(m.start(), excluded_ranges):
            continue
        name = m.group(1)
        desc = scalar_map.get(name)
        if desc is None:
            desc = ScalarDescriptor(name=name)
            scalar_map[name] = desc
        desc.occurrences.append(_Span(m.start(), m.end()))
        desc.lines.append(_line_of(html, m.start()))
        # Detect if this occurrence is inside a ``/* {{X}} */`` chart-scalar.
        for cs, ce in chart_scalar_outer_ranges:
            if cs <= m.start() < ce:
                desc.in_chart_scalar_comment = True
                break

    # Stable order: source order of the first occurrence.
    scalars = sorted(scalar_map.values(), key=lambda d: d.occurrences[0].start)

    # ── 7. Find ``data-block``-tagged regions and dispatch every marker
    #      to its closest-ancestor block.  Markers without any ancestor
    #      surface as orphans so the validator / agent can flag them.
    comment_ranges = [(m.start(), m.end()) for m in _RE_HTML_COMMENT.finditer(html)]
    blocks = _find_blocks(html, comment_ranges)
    orphans: List[OrphanMarker] = []

    def _seen_in(lst: List[str], name: str) -> None:
        if name not in lst:
            lst.append(name)

    # Scalars: a single ``{{TOKEN}}`` may appear in multiple blocks
    # (e.g. ``CLIENT_NAME`` is reused on the cover and in the document
    # ``<title>``).  Each occurrence is dispatched independently so every
    # owning block lists the token in ``inner_scalars``.
    for s in scalars:
        owners_seen: set = set()
        for occ in s.occurrences:
            b = _innermost_block(occ.start, blocks)
            if b is None:
                line = _line_of(html, occ.start)
                orphans.append(OrphanMarker(kind="scalar", name=s.name, line=line))
            else:
                if id(b) not in owners_seen:
                    owners_seen.add(id(b))
                    _seen_in(b.inner_scalars, s.name)

    # Sections — owned by the block enclosing the BEGIN comment; nested
    # sections still belong to that block (they remain inner-of-section
    # for SQL purposes but the block is the unit-of-work).
    for sec in sections:
        b = _innermost_block(sec.begin_marker.start, blocks)
        if b is None:
            orphans.append(OrphanMarker(kind="section", name=sec.name, line=sec.line))
        else:
            _seen_in(b.inner_sections, sec.name)

    # Conditions
    for c in conditions:
        b = _innermost_block(c.begin_marker.start, blocks)
        if b is None:
            orphans.append(OrphanMarker(kind="condition", name=c.name, line=c.line))
        else:
            _seen_in(b.inner_conditions, c.name)

    # Narratives
    for n in narratives:
        b = _innermost_block(n.marker.start, blocks)
        if b is None:
            orphans.append(OrphanMarker(kind="narrative", name=n.name, line=n.line))
        else:
            _seen_in(b.inner_narratives, n.name)

    # Chart arrays
    for ch in chart_arrays:
        b = _innermost_block(ch.marker.start, blocks)
        if b is None:
            orphans.append(OrphanMarker(kind="chart_array", name=ch.name, line=ch.line))
        else:
            _seen_in(b.inner_chart_arrays, ch.name)

    for b in blocks:
        b.kind = _infer_block_kind(b)

    return ScanResult(
        scalars       = scalars,
        sections      = sections,
        conditions    = conditions,
        narratives    = narratives,
        chart_arrays  = chart_arrays,
        template_html = html,
        blocks        = blocks,
        orphans       = orphans,
    )


# ── PocketFlow node wrapper ─────────────────────────────────────────────────


class TemplateScanNode(BaseNode):
    """Pure parser node — reads the HTML template, returns a ScanResult.

    Inputs:
        ``template_path`` (str | Path) — path to ``report-template.html``,
        OR ``template_html`` (str) — in-memory template source.

    Outputs:
        ``template_scan`` (ScanResult)
    """

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "TemplateScan")

    def prep(self, shared: Dict[str, Any]) -> str:
        self.log_entry(shared)
        if shared.get("template_html"):
            html = shared["template_html"]
        else:
            template_path = shared.get("template_path")
            if not template_path:
                raise ValueError(
                    "TemplateScanNode requires 'template_path' or 'template_html' "
                    "in shared state"
                )
            html = Path(template_path).read_text(encoding="utf-8")
        return html

    def exec(self, html: str) -> ScanResult:
        result = scan_template(html)
        self.logger.info(
            "Template scan complete: %d scalars, %d sections "
            "(%d nested), %d conditions, %d narratives, %d chart arrays, "
            "%d blocks (%d orphan markers)",
            len(result.scalars),
            len(result.sections),
            sum(1 for s in result.sections if s.parent),
            len(result.conditions),
            len(result.narratives),
            len(result.chart_arrays),
            len(result.blocks),
            len(result.orphans),
        )
        return result

    def post(self, shared: Dict[str, Any], prep_result: Any, exec_result: ScanResult) -> str:
        shared["template_scan"] = exec_result
        self.log_exit("default")
        return "default"
