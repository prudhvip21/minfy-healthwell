"""
Input and output gates around every agent.

The output gate is the important one. It re-checks whatever a model produced
against the user's recorded allergies and diet using the engine's own rules —
so a confident, fluent, wrong answer still cannot reach the plan.
"""

from __future__ import annotations

import re

from .engine import profile_conflicts
from .util import iso_now

_INJECTION_SOURCES = [
    r'ignore (all |any )?(previous|prior|above) instructions',
    r'disregard (the )?(system|above|previous)',
    r'you are now (a|an|in) ',
    r'\bsystem prompt\b',
    r'\bdeveloper mode\b',
    r'<\s*\/?\s*(system|instructions)\s*>',
    r'reveal (your|the) (prompt|instructions|rules)',
]
INJECTION_PATTERNS = [(src, re.compile(src, re.IGNORECASE)) for src in _INJECTION_SOURCES]

# re.ASCII keeps \w, \d and \b matching the JavaScript originals exactly.
PII_PATTERNS = [
    (re.compile(r'\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b', re.ASCII), '[email]'),
    (re.compile(r'\b(?:\+91[-\s]?)?[6-9]\d{9}\b', re.ASCII), '[phone]'),
    (re.compile(r'\b\d{4}\s?\d{4}\s?\d{4}\b', re.ASCII), '[aadhaar-like]'),
    (re.compile(r'\b[A-Z]{5}\d{4}[A-Z]\b', re.ASCII), '[pan-like]'),
]


def scan_input(raw) -> dict:
    text = str(raw or '')
    injection = [src for src, rx in INJECTION_PATTERNS if rx.search(text)]

    clean, redacted = text, []
    for rx, label in PII_PATTERNS:
        if rx.search(clean):
            redacted.append(label)
            clean = rx.sub(label, clean)

    if injection:
        note = ('Input contains instruction-override patterns. Passed to the model as untrusted user content; '
                'the agent may not act on instructions found inside it.')
    elif redacted:
        note = f"Redacted {', '.join(redacted)} before the call."
    else:
        note = None

    return {'clean': clean, 'verdict': 'flagged' if injection else 'pass',
            'injection': injection, 'redacted': redacted, 'note': note}


def scan_items(user: dict, items: list) -> dict:
    """Check model-produced food items against the user's profile."""
    conflicts = profile_conflicts(user, items)
    high = [c for c in conflicts if c['severity'] == 'high']
    low = [c for c in conflicts if c['severity'] != 'high']

    blocked_names = {c['item'] for c in high}

    def label(i):
        return i.get('name') if isinstance(i, dict) and i.get('name') is not None else i

    allowed = [i for i in items if label(i) not in blocked_names]
    verdict = 'blocked' if high else 'review' if low else 'pass'

    if high:
        note = f"{len(high)} item(s) blocked by the engine before any plan write: {', '.join(c['item'] for c in high)}."
    elif low:
        note = f"{len(low)} item(s) flagged for a dietitian's eye."
    else:
        note = None

    return {'verdict': verdict, 'blocked': high, 'flagged': low, 'allowed': allowed, 'note': note}


def verdict_record(inp: dict | None, out: dict | None) -> dict:
    """What goes on the trace row, so the Trace Console shows what the gates did on every call."""
    return {
        'input': {'verdict': inp['verdict'], 'injection': inp['injection'], 'redacted': inp['redacted']} if inp else None,
        'output': {'verdict': out['verdict'], 'blocked': [b['item'] for b in out['blocked']],
                   'flagged': [f['item'] for f in out['flagged']]} if out else None,
        'at': iso_now(),
    }
