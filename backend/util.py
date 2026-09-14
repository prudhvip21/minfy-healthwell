"""Helpers that keep the Python engine numerically identical to the original JavaScript."""

from __future__ import annotations

import math
from datetime import datetime, timezone


def js_round(x: float) -> int:
    """JavaScript's Math.round: halves round towards +infinity.

    Python's round() rounds halves to even, which would silently move scores
    and calorie figures by a point against the numbers already documented.
    """
    return math.floor(x + 0.5)


def round1(x: float) -> float:
    """Round to one decimal place, JavaScript-style."""
    return js_round(x * 10) / 10


def js_number(v) -> float:
    """JavaScript's Number(): null -> 0, '' -> 0, unparseable -> NaN."""
    if v is None:
        return 0.0
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if not s:
        return 0.0
    try:
        return float(s)
    except ValueError:
        return math.nan


def num(v) -> str:
    """Render a number as a JavaScript template string would: 12.0 -> '12'."""
    if v is None:
        return 'null'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, float):
        if math.isnan(v):
            return 'NaN'
        if v.is_integer():
            return str(int(v))
    return str(v)


def iso_now() -> str:
    """Equivalent of new Date().toISOString()."""
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
