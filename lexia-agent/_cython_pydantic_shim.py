"""
Cython ↔ Pydantic 2 compatibility shim.

When this module is compiled with Cython, its class methods become
``cyfunction`` objects. Pydantic 2's metaclass rejects unannotated
class attributes unless their type is listed in
``pydantic._internal._model_construction.IGNORED_TYPES``. Regular
Python functions are on that list; cyfunction is not, so Pydantic
raises ``PydanticUserError`` for every ``BaseModel`` with compiled
methods.

Strategy: at application startup (before any of our own BaseModel
subclasses are defined) we introspect this module's compiled method
to learn the concrete ``cyfunction`` type, then add it to
``IGNORED_TYPES``. In a dev (pure-Python) run this is a no-op.

Must be imported first-thing in ``main.py``.
"""

from __future__ import annotations


class _Probe:
    """Helper class — its method is a cyfunction in compiled releases."""

    def _m(self):  # noqa: D401 — intentional no-op
        return None


# Evaluated at import time: cyfunction in compiled release, function in dev.
_METHOD_TYPE = type(_Probe()._m)


def patch_pydantic() -> bool:
    """Register our cyfunction type in Pydantic's IGNORED_TYPES.

    Returns True if patching was applied, False otherwise.
    """
    try:
        from pydantic._internal import _model_construction as _pmc
    except ImportError:
        return False

    ignored = getattr(_pmc, "IGNORED_TYPES", ())
    if _METHOD_TYPE in ignored:
        return True

    _pmc.IGNORED_TYPES = tuple(set(ignored) | {_METHOD_TYPE})
    return True
