"""
Golden test for the rules engine.

tests/golden/engine_cases.json holds outputs recorded from the original
JavaScript engine immediately before it was retired, for a fixed set of inputs:
food-name similarity, name normalisation, macro estimation, slot normalisation,
allergy/diet conflicts and macro filling. The Python engine must reproduce every
one of them. Any change to engine behaviour should fail here first.

    uv run python tests/test_engine_golden.py
"""

import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import engine  # noqa: E402

golden = json.loads((ROOT / 'tests' / 'golden' / 'engine_cases.json').read_text(encoding='utf-8'))
users = golden['users']

FUNCTIONS = {
    'similarity': lambda args: engine.similarity(*args),
    'normaliseName': lambda args: engine.normalise_name(*args),
    'estimateMacros': lambda args: engine.estimate_macros(*args),
    'normaliseSlot': lambda args: engine.normalise_slot(*args),
    'profileConflicts': lambda args: engine.profile_conflicts(users[args[0]], args[1]),
    'withMacros': lambda args: engine.with_macros(args[0]),
}


def same(a, b) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return math.isclose(a, b, rel_tol=0, abs_tol=1e-9)
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    return a == b


def main() -> int:
    failures = 0
    for case in golden['cases']:
        got = FUNCTIONS[case['fn']](case['args'])
        if not same(case['out'], got):
            failures += 1
            print(f"FAIL {case['fn']}{tuple(case['args'])}")
            print(f"    expected: {json.dumps(case['out'], ensure_ascii=False)}")
            print(f"    got:      {json.dumps(got, ensure_ascii=False)}")
    print(f"{len(golden['cases'])} golden cases, {failures} failures")
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
