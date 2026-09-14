"""HealthWise Platform 2.0 — Python backend."""

import sys
from pathlib import Path

from dotenv import load_dotenv

# Load .env before any module reads the environment (models, API key, DB path).
load_dotenv(Path(__file__).resolve().parent.parent / '.env')

# Windows consoles default to cp1252, which cannot print the arrows and dashes
# used in log lines. A crash on a print statement is a poor way to fail a demo.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError):
        pass
