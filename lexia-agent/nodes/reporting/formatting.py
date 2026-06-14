"""Formatting helpers for ``template_render_node``.

Each helper takes a raw value and returns a string ready to drop into the
HTML output.  These match the conventions encoded in ``model1``'s "RULES"
comment block:

- amounts use a non-breaking space as thousands separator and ``&euro;`` as
  the currency symbol  (``8 083 &euro;``)
- missing amounts render as the em-dash entity ``&mdash;``
- percentages use ``%`` with no space (``85%``)
- positive-only/negative-only signed values use ``+``/``-`` prefix when
  ``signed=True``

The renderer is the only consumer; everything is opt-in via the field's
``format:`` key in ``definitions.yaml``.
"""

from __future__ import annotations

import math
from datetime import date, datetime
from typing import Any, Callable, Dict, List

NBSP = "\u00a0"
EM_DASH_HTML = "&mdash;"
EUR_HTML     = f"{NBSP}&euro;"


# ── Predicates ──────────────────────────────────────────────────────────────


def _is_missing(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, float) and math.isnan(value):
        return True
    if isinstance(value, str) and value.strip() in ("", "—", "-", "&mdash;"):
        return True
    return False


def _coerce_number(value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.replace(NBSP, "").replace(" ", "").replace(",", ".")
        return float(cleaned)
    raise TypeError(f"Cannot coerce {type(value).__name__} to number: {value!r}")


# ── Numeric formatters ──────────────────────────────────────────────────────


def fmt_eur(value: Any, *, signed: bool = False) -> str:
    """``8 083 &euro;`` (positive)  /  ``-8 083 &euro;`` (negative)."""
    if _is_missing(value):
        return EM_DASH_HTML
    n = int(round(_coerce_number(value)))
    body = f"{abs(n):,}".replace(",", NBSP)
    if n < 0:
        return f"-{body}{EUR_HTML}"
    if signed and n > 0:
        return f"+{body}{EUR_HTML}"
    return f"{body}{EUR_HTML}"


def fmt_signed_eur(value: Any) -> str:
    """``+8 083 &euro;`` / ``-8 083 &euro;``."""
    return fmt_eur(value, signed=True)


def fmt_eur_compact(value: Any) -> str:
    """``8 083`` (no currency symbol — used in compact monthly tables)."""
    if _is_missing(value):
        return EM_DASH_HTML
    n = int(round(_coerce_number(value)))
    body = f"{abs(n):,}".replace(",", NBSP)
    return f"-{body}" if n < 0 else body


def fmt_int_thousands(value: Any) -> str:
    """``307 432`` — plain integer with NBSP thousands."""
    if _is_missing(value):
        return EM_DASH_HTML
    n = int(round(_coerce_number(value)))
    return f"{n:,}".replace(",", NBSP)


def fmt_percent_int(value: Any) -> str:
    """``85%`` — already-percent input (0-100), rounded to int."""
    if _is_missing(value):
        return EM_DASH_HTML
    n = int(round(_coerce_number(value)))
    return f"{n}%"


def fmt_percent_ratio(value: Any) -> str:
    """``85%`` — input is a 0-1 ratio, multiplied by 100 then rounded."""
    if _is_missing(value):
        return EM_DASH_HTML
    return fmt_percent_int(_coerce_number(value) * 100)


def fmt_percent_pct(value: Any) -> str:
    """``85.5%`` — already-percent input (0-100) with 1 decimal."""
    if _is_missing(value):
        return EM_DASH_HTML
    n = _coerce_number(value)
    return f"{n:.1f}%"


# ── Boolean / passthrough / dates ───────────────────────────────────────────


def fmt_bool(value: Any) -> str:
    return "true" if bool(value) else "false"


def fmt_string(value: Any) -> str:
    if _is_missing(value):
        return EM_DASH_HTML
    return str(value)


def fmt_em_dash_when_missing(value: Any) -> str:
    if _is_missing(value):
        return EM_DASH_HTML
    return str(value)


def fmt_date_fr(value: Any) -> str:
    """``DD/MM/YYYY`` — French short date."""
    if _is_missing(value):
        return EM_DASH_HTML
    if isinstance(value, (date, datetime)):
        d = value.date() if isinstance(value, datetime) else value
        return f"{d.day:02d}/{d.month:02d}/{d.year}"
    return str(value)


def fmt_passthrough(value: Any) -> str:
    if _is_missing(value):
        return ""
    return str(value)


# ── Registry ────────────────────────────────────────────────────────────────


_FORMATTERS: Dict[str, Callable[[Any], str]] = {
    # currency
    "eur":            fmt_eur,
    "currency":       fmt_eur,            # alias
    "signed_eur":     fmt_signed_eur,
    "eur_compact":    fmt_eur_compact,    # no symbol — for monthly tables
    "int_thousands":  fmt_int_thousands,
    # percent
    "percent_int":    fmt_percent_int,    # 85%
    "percent_pct":    fmt_percent_pct,    # 85.5%
    "percent_ratio":  fmt_percent_ratio,  # 0.85 → 85%
    # generic
    "bool":           fmt_bool,
    "string":         fmt_string,
    "text":           fmt_string,         # alias
    "em_dash":        fmt_em_dash_when_missing,
    "date":           fmt_date_fr,
    "date_fr":        fmt_date_fr,
    "passthrough":    fmt_passthrough,
    # raw — never formatted, always coerced to ``str()`` (caller is responsible)
    "raw":            fmt_passthrough,
}


def format_value(value: Any, format_name: str = "passthrough") -> str:
    """Format *value* using the named formatter; unknown names fall back to
    ``passthrough`` and emit a warning-friendly diagnostic."""
    fmt = _FORMATTERS.get(format_name or "passthrough")
    if fmt is None:
        return fmt_passthrough(value)
    return fmt(value)


def list_formatters() -> List[str]:
    """Return the names of all registered formatters (for the agent's UI)."""
    return sorted(_FORMATTERS.keys())
