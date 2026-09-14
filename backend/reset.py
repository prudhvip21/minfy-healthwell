"""
Wipe and rebuild the demo database.

Parsed plans are expensive (one GPT-5 call per document), so by default a reset
keeps the stored parse and only rebuilds the state a demo mutates: check-ins,
proposals, nudges, traces and history. Pass reparse=True to go all the way back
to the documents.

Run standalone:  uv run python -m backend.reset [--reparse]
"""

from __future__ import annotations

import sys

from .db import wipe
from .plan_import import import_plans


def reset_demo(reparse: bool = False, log=print) -> list:
    wipe(keep_plans=not reparse)
    return import_plans(force=reparse, log=log)


if __name__ == '__main__':
    for row in reset_demo(reparse='--reparse' in sys.argv):
        print(' ', row)
