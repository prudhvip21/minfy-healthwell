"""
DOCX diet plan -> canonical structured plan.

Dietitian plans are written for humans: the tables are transposed (rows are
meal slots, columns are days), quantities are glued to food names ("Idli-3no"),
alternatives are expressed in prose ("Curd-1/2cup or Buttermilk-1glass"), one
cell can hold three items at three different times, and the food names are
regional. No macros appear anywhere.

That is precisely the "unstructured input becomes a database row" job the
advisory note assigns to the LLM — so the model does the structure, and the
engine owns every number it produces.

Run standalone:  uv run python -m backend.plan_import [--force]
"""

from __future__ import annotations

import hashlib
import io
import json
import sys

import mammoth

from .db import DATA_DIR, PLANS_DIR, all_rows, get_row, insert, run
from .engine import add_days, estimate_macros, materialise_plan, normalise_slot, profile_conflicts, today
from .llm import call_model, has_key, json_schema
from .seed import HISTORY_DAYS, ensure_users, seed_cohort_stats, seed_history, seed_partners
from .util import js_round

MAP_PATH = DATA_DIR / 'plan-map.json'

# Items the model was less sure about than this go to a dietitian.
PARSE_REVIEW_THRESHOLD = 0.75

_NUMBER_OR_NULL = {'type': ['number', 'null']}

PLAN_SCHEMA = json_schema('diet_plan', {
    'type': 'object',
    'additionalProperties': False,
    'required': ['plan_title', 'cycle_days', 'days', 'guidance', 'targets_stated', 'parse_notes'],
    'properties': {
        'plan_title': {'type': 'string'},
        'cycle_days': {'type': 'integer', 'description': 'How many distinct days the plan authors'},
        'targets_stated': {
            'type': 'object',
            'additionalProperties': False,
            'required': ['present', 'kcal', 'protein_g', 'carbs_g', 'fat_g'],
            'description': 'Only fill these if the document literally states targets. Otherwise present=false and nulls.',
            'properties': {
                'present': {'type': 'boolean'},
                'kcal': dict(_NUMBER_OR_NULL),
                'protein_g': dict(_NUMBER_OR_NULL),
                'carbs_g': dict(_NUMBER_OR_NULL),
                'fat_g': dict(_NUMBER_OR_NULL),
            },
        },
        'days': {
            'type': 'array',
            'items': {
                'type': 'object',
                'additionalProperties': False,
                'required': ['day_index', 'label', 'meals'],
                'properties': {
                    'day_index': {'type': 'integer'},
                    'label': {'type': 'string'},
                    'meals': {
                        'type': 'array',
                        'items': {
                            'type': 'object',
                            'additionalProperties': False,
                            'required': ['slot', 'time_hint', 'items'],
                            'properties': {
                                'slot': {'type': 'string'},
                                'time_hint': {'type': ['string', 'null']},
                                'items': {
                                    'type': 'array',
                                    'items': {
                                        'type': 'object',
                                        'additionalProperties': False,
                                        'required': ['name', 'qty', 'unit', 'alternatives', 'notes', 'confidence', 'source_text'],
                                        'properties': {
                                            'name': {'type': 'string', 'description': 'Food name only, no quantity'},
                                            'qty': {'type': ['number', 'null']},
                                            'unit': {'type': ['string', 'null'], 'description': 'no, cup, tsp, tbsp, glass, handful, g, ml'},
                                            'alternatives': {
                                                'type': 'array',
                                                'items': {'type': 'string'},
                                                'description': 'Other foods the user may have instead of this one, when the cell says "or"',
                                            },
                                            'notes': {'type': ['string', 'null'], 'description': 'Preparation asides, e.g. "add 1tsp ghee"'},
                                            'confidence': {'type': 'number', 'description': '0-1, how certain the extraction is'},
                                            'source_text': {'type': 'string', 'description': 'The exact fragment this came from'},
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
        'guidance': {'type': 'array', 'items': {'type': 'string'}, 'description': 'General instructions outside the meal grid'},
        'parse_notes': {'type': 'string', 'description': 'Anything ambiguous or unreadable'},
    },
})

SYSTEM = """You convert Indian dietitian meal-plan documents into structured data.

These documents are laid out for a human reader. Expect all of the following:

- TRANSPOSED TABLES. The first column is the meal slot ("Wake up Meal", "Breakfast",
  "Mid-Morning", "Lunch", "Post Exercise", "Dinner", "Post Dinner"), the second column
  is the time, and EACH REMAINING COLUMN IS A SEPARATE DAY ("Day-1", "Day-2", ...).
  A document often contains several tables covering different days; merge them into
  one ordered list of days and number them from the column headers, not the table order.
- MULTI-ITEM CELLS. One cell can hold several foods, separated by commas or on
  separate lines. Emit one item per distinct food. A cell with three lines and a
  time column listing three times means one item per time.
- GLUED QUANTITIES. "Idli-3no" is 3 idli. "Coconut Chutney-3tbsp" is 3 tbsp.
  "Curd-1/2cup" is 0.5 cup. "Roasted Peanuts-1Handful" is 1 handful. Separate the
  food name from the number and the unit. Never leave a quantity inside the name.
- ALTERNATIVES. "Curd-1/2cup or Buttermilk with jeera-1glass" is ONE item (curd)
  with one alternative (buttermilk), not two items.
- PARENTHETICAL PREPARATION. "(add 1tsp of ghee)" is a note on the item it follows,
  not a separate food — unless it is clearly its own line.
- REGIONAL NAMES. Thotakura Pappu, Bendakaya Curry, Goru Chikudikaya, Putnallu,
  Raitha, Poha, Rasam, Sambar. Keep the dietitian's name for the food exactly as
  written; do not translate or "correct" it.

Set confidence below 0.75 for anything genuinely ambiguous — a vague item like
"Fruit-1no" with no fruit named, an unreadable fragment, or a quantity you had to
guess. Those go to a human dietitian for review, so be honest rather than generous.

Do NOT invent calories or macros. The engine computes those separately."""


def list_plan_files() -> list:
    if not PLANS_DIR.exists():
        return []
    return sorted(f.name for f in PLANS_DIR.iterdir()
                  if f.name.lower().endswith('.docx') and not f.name.startswith('~$'))


def plan_assignment(users: list, files: list) -> dict:
    """
    Which document belongs to which user. Written to data/plan-map.json on first
    run so it can be edited by hand; documents are shared round-robin when there
    are fewer documents than users.
    """
    try:
        mapping = json.loads(MAP_PATH.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        mapping = {}

    changed = False
    for i, u in enumerate(users):
        if mapping.get(u['id']) and mapping[u['id']] in files:
            continue
        mapping[u['id']] = files[i % len(files)] if files else None
        changed = True

    if changed:
        try:
            MAP_PATH.write_text(json.dumps(mapping, indent=2, ensure_ascii=False), encoding='utf-8')
        except OSError:
            pass
    return mapping


def _file_hash(buffer: bytes) -> str:
    return hashlib.sha256(buffer).hexdigest()[:16]


def parse_document(file: str, user_id: str) -> dict:
    buffer = (PLANS_DIR / file).read_bytes()
    html = mammoth.convert_to_html(io.BytesIO(buffer)).value
    res = call_model(
        route='plan.parse',
        user_id=user_id,
        system=SYSTEM,
        input=f'Convert this meal plan document into structured data.\n\nFile: {file}\n\n{html}',
        format=PLAN_SCHEMA,
        # One call per document and everything downstream depends on it — but
        # the work is careful transcription, not deep reasoning, so medium effort
        # with a generous budget beats high effort racing a token cap.
        effort='medium',
        max_output=48000,
        timeout_s=300,
    )
    return {'parsed': res['data'], 'hash': _file_hash(buffer), 'html': html,
            'traceId': res['traceId'], 'degraded': res['degraded'], 'degradedNote': res.get('degradedNote')}


def store_plan(user: dict, file: str, file_hash: str, parsed: dict, parse_status: str, note: str | None):
    """Write a parsed plan to the database and materialise it onto dates."""
    clear_user_plan(user['id'])

    stated = parsed.get('targets_stated') or {}
    days = parsed.get('days') or []
    plan_id = insert('plans', {
        'user_id': user['id'],
        'source_file': file,
        'file_hash': file_hash,
        'start_date': user['start_date'],
        'duration_days': parsed.get('cycle_days') or len(days) or 7,
        'targets_json': ({'kcal': stated.get('kcal'), 'protein_g': stated.get('protein_g'),
                          'carbs_g': stated.get('carbs_g'), 'fat_g': stated.get('fat_g'), 'source': 'document'}
                         if stated.get('present') else {'source': 'estimated'}),
        'guidance_json': parsed.get('guidance') or [],
        'parse_status': parse_status,
        'parse_note': note or parsed.get('parse_notes') or None,
    })

    low_confidence, all_items = [], []
    for day in days:
        day_id = insert('plan_days', {
            'plan_id': plan_id,
            'day_index': day['day_index'],
            'label': day.get('label') or f"Day {day['day_index']}",
        })
        for meal in day.get('meals') or []:
            slot = normalise_slot(meal.get('slot'))
            for item in meal.get('items') or []:
                qty = item['qty'] if item.get('qty') is not None else 1
                macros = estimate_macros(item['name'], qty, item.get('unit'))
                alternatives = item.get('alternatives') or []
                alt_note = f"or {' / '.join(alternatives)}" if alternatives else None
                notes = ' · '.join(x for x in (item.get('notes'), alt_note) if x) or None
                confidence = item['confidence'] if item.get('confidence') is not None else 1

                item_id = insert('plan_items', {
                    'plan_day_id': day_id, 'slot': slot, 'time_hint': meal.get('time_hint'),
                    'name': item['name'], 'qty': qty, 'unit': item.get('unit'),
                    'kcal': macros['kcal'], 'protein_g': macros['protein_g'],
                    'carbs_g': macros['carbs_g'], 'fat_g': macros['fat_g'],
                    'notes': notes, 'confidence': confidence, 'source_text': item.get('source_text'),
                    'macro_source': 'estimated',
                })

                all_items.append({'id': item_id, 'name': item['name'], 'notes': notes, 'day': day['day_index'], 'slot': slot})
                if confidence < PARSE_REVIEW_THRESHOLD:
                    low_confidence.append({'id': item_id, 'name': item['name'], 'day': day['day_index'], 'slot': slot,
                                           'confidence': item.get('confidence'), 'source_text': item.get('source_text')})

    # Expand the authored cycle across the history window and two weeks forward.
    start = user.get('start_date') or add_days(today(), -(HISTORY_DAYS - 1))
    materialise_plan(user['id'], plan_id, start, HISTORY_DAYS + 14, force=True)
    return plan_id, low_confidence, all_items


def raise_reviews(user: dict, plan_id: int, low_confidence: list, all_items: list, file: str,
                  include_parse: bool = True) -> int:
    """Raise dietitian review items: unsure extractions, and plan contents that collide with the profile."""
    # Extraction doubts belong to the document, not the user — raise them once per
    # document, and once per distinct fragment: "Fruit-1no" on three days is one
    # question for a dietitian, not three.
    groups: dict = {}
    for item in (low_confidence if include_parse else []):
        key = ' '.join(str(item.get('source_text') or item['name']).split()).lower()
        if key not in groups:
            groups[key] = {**item, 'occurrences': []}
        groups[key]['occurrences'].append({'day': item['day'], 'slot': item['slot'], 'plan_item_id': item['id']})

    for g in groups.values():
        count = len(g['occurrences'])
        repeat = f' ×{count}' if count > 1 else ''
        appears = f', which appears {count}× in the document' if count > 1 else ''
        insert('plan_changes', {
            'user_id': user['id'], 'kind': 'parse_review',
            'summary': f'Unclear: "{g["name"]}" · {g["slot"]}{repeat}',
            'proposal_json': {**g, 'source_file': file},
            'confidence': g['confidence'],
            'status': 'pending',
            'reason': (f'Extraction confidence {js_round(g["confidence"] * 100)}% from the source text '
                       f'"{g["source_text"]}"{appears}. A dietitian should confirm the food and quantity.'),
        })

    # Profile conflicts, grouped by the ingredient that triggered them. The
    # document repeats foods daily and puts ghee in half the notes; a dietitian
    # needs one row per ingredient decision, not forty.
    groups_by_term: dict = {}
    for item in all_items:
        for c in profile_conflicts(user, [item]):
            key = f"{c['kind']}:{c['allergen']}:{c['matched']}"
            if key not in groups_by_term:
                groups_by_term[key] = {'conflict': c, 'items': [], 'occurrences': []}
            g = groups_by_term[key]
            if item['name'] not in g['items']:
                g['items'].append(item['name'])
            g['occurrences'].append({'day': item['day'], 'slot': item['slot'], 'item': item['name']})

    for g in groups_by_term.values():
        c, items = g['conflict'], g['items']
        against = f"{c['allergen']} allergy" if c['kind'] == 'allergy' else f"not {user['diet']}"
        summary = f"{c['matched']} in {len(items)} items · {against}" if len(items) > 1 else f'{items[0]} · {against}'
        tail = ('The engine blocked auto-approval; a dietitian decides the substitution.' if c['severity'] == 'high'
                else 'Not blocking; flagged for a dietitian to confirm.')
        insert('plan_changes', {
            'user_id': user['id'],
            'kind': 'parse_review',
            'summary': summary,
            'proposal_json': {'conflict': c, 'items': items, 'occurrences': g['occurrences'], 'source_file': file},
            'confidence': None,
            'status': 'pending',
            'reason': f"{c['reason']} Affects {', '.join(items)} — {len(g['occurrences'])}× across the plan. {tail}",
        })

    return len(groups_by_term) + len(groups)


def clear_user_plan(user_id: str) -> None:
    """
    Replacing a plan invalidates everything derived from its dated entries —
    check-ins point at entry ids that are about to disappear. Clear the user's
    derived state so seed_history rebuilds it. Traces are kept: they are a log.
    """
    for t in ('checkin_items', 'checkins', 'plan_changes', 'nudges', 'events', 'plan_entries'):
        run(f'DELETE FROM {t} WHERE user_id = ?', user_id)
    run('DELETE FROM plans WHERE user_id = ?', user_id)   # cascades to plan_days and plan_items


def seed_fallback_plan(user: dict, file: str | None = None,
                       reason: str = 'No plan document is assigned to this user.') -> int:
    """Minimal plan used only when the assigned document cannot be parsed."""
    clear_user_plan(user['id'])
    plan_id = insert('plans', {
        'user_id': user['id'], 'source_file': file, 'file_hash': None,
        'start_date': user['start_date'], 'duration_days': 1,
        'targets_json': {'source': 'estimated'},
        'guidance_json': ['Fallback plan — the source document has not been parsed.'],
        'parse_status': 'failed',
        'parse_note': reason,
    })
    day_id = insert('plan_days', {'plan_id': plan_id, 'day_index': 1, 'label': 'Fallback day'})
    for slot, time_hint, name, qty, unit in [
        ('Breakfast', '8:00 AM', 'Idli', 3, 'no'),
        ('Lunch', '1:00 PM', 'Rice', 1, 'cup'),
        ('Lunch', '1:00 PM', 'Dal', 1, 'cup'),
        ('Snack', '5:00 PM', 'Tea', 1, 'cup'),
        ('Dinner', '8:00 PM', 'Roti', 2, 'no'),
        ('Dinner', '8:00 PM', 'Mixed Vegetable Curry', 1, 'cup'),
    ]:
        m = estimate_macros(name, qty, unit)
        insert('plan_items', {
            'plan_day_id': day_id, 'slot': slot, 'time_hint': time_hint, 'name': name, 'qty': qty, 'unit': unit,
            'kcal': m['kcal'], 'protein_g': m['protein_g'], 'carbs_g': m['carbs_g'], 'fat_g': m['fat_g'],
            'confidence': 1, 'source_text': 'seeded fallback', 'macro_source': 'estimated',
        })
    materialise_plan(user['id'], plan_id, user['start_date'], HISTORY_DAYS + 14, force=True)
    return plan_id


def rehydrate(user: dict, plan: dict, file: str, include_parse: bool = True):
    """
    Rebuild everything derived from an already-parsed plan. A demo reset keeps
    the stored parse (a GPT-5 call per document) but clears the dated entries
    and the review queue, so both are regenerated from what is stored.
    """
    rows = all_rows(
        """SELECT pi.*, pd.day_index FROM plan_items pi
             JOIN plan_days pd ON pd.id = pi.plan_day_id
            WHERE pd.plan_id = ? ORDER BY pd.day_index, pi.id""",
        plan['id'],
    )

    # Estimates are the engine's, not the parse's — recompute them from the
    # current food table so improving the table never needs a model call.
    for r in rows:
        if r['macro_source'] != 'estimated':
            continue
        e = estimate_macros(r['name'], r['qty'], r['unit'])
        run('UPDATE plan_items SET kcal = ?, protein_g = ?, carbs_g = ?, fat_g = ? WHERE id = ?',
            e['kcal'], e['protein_g'], e['carbs_g'], e['fat_g'], r['id'])

    all_items = [{'id': r['id'], 'name': r['name'], 'notes': r['notes'], 'day': r['day_index'], 'slot': r['slot']} for r in rows]
    low_confidence = [
        {'id': r['id'], 'name': r['name'], 'day': r['day_index'], 'slot': r['slot'],
         'confidence': r['confidence'], 'source_text': r['source_text']}
        for r in rows if (r['confidence'] if r['confidence'] is not None else 1) < PARSE_REVIEW_THRESHOLD
    ]

    if get_row('SELECT COUNT(*) AS n FROM plan_entries WHERE user_id = ?', user['id'])['n'] == 0:
        materialise_plan(user['id'], plan['id'], user['start_date'], HISTORY_DAYS + 14, force=True)

    has_reviews = get_row("SELECT COUNT(*) AS n FROM plan_changes WHERE user_id = ? AND kind = 'parse_review'", user['id'])['n']
    reviews = has_reviews or raise_reviews(user, plan['id'], low_confidence, all_items, file, include_parse=include_parse)
    return len(rows), reviews


def import_plans(force: bool = False, log=print) -> list:
    """Full bootstrap: users, plans, history, reference data. Unchanged documents are not re-parsed."""
    users = ensure_users()
    seed_cohort_stats()
    seed_partners()

    files = list_plan_files()
    mapping = plan_assignment(users, files)
    report = []
    # Users sharing a document share one parse — one model call per file, not
    # per user — and one set of extraction questions for the dietitian.
    parsed_by_hash: dict = {}
    parse_reviewed: set = set()

    if not files:
        log('No .docx files in plans/ — every user falls back to a seeded plan.')
    elif len(files) < len(users):
        log(f'{len(files)} plan document(s) for {len(users)} users — documents are shared; '
            'drop more .docx files in plans/ and re-run.')

    for user in users:
        file = mapping.get(user['id'])
        existing = get_row('SELECT * FROM plans WHERE user_id = ? ORDER BY id DESC LIMIT 1', user['id'])

        if not file:
            if not existing:
                seed_fallback_plan(user)
            report.append({'user': user['id'], 'file': None, 'status': 'fallback', 'items': 0, 'reviews': 0})
            continue

        file_hash = _file_hash((PLANS_DIR / file).read_bytes())

        if not force and existing and existing['file_hash'] == file_hash and existing['parse_status'] == 'parsed':
            items, reviews = rehydrate(user, existing, file, include_parse=file_hash not in parse_reviewed)
            parse_reviewed.add(file_hash)
            report.append({'user': user['id'], 'file': file, 'status': 'cached', 'items': items, 'reviews': reviews})
            log(f"{user['name']}: {file} unchanged — reusing the stored parse ({items} items).")
            continue

        if not has_key():
            if not existing:
                seed_fallback_plan(user, file=file, reason='Waiting for OPENAI_API_KEY — the document will be parsed on the next start once the key is in .env.')
            report.append({'user': user['id'], 'file': file, 'status': 'no-key', 'items': 0, 'reviews': 0})
            log(f"{user['name']}: OPENAI_API_KEY not set — using a fallback plan.")
            continue

        try:
            parse = parsed_by_hash.get(file_hash)
            if parse:
                log(f"{user['name']}: {file} already parsed this run — reusing it.")
            else:
                log(f"{user['name']}: parsing {file} (one model call — can take a minute or two) …")
                parse = parse_document(file, user['id'])
                parsed_by_hash[file_hash] = parse

            parsed = parse['parsed']
            plan_id, low_confidence, all_items = store_plan(
                user, file, file_hash, parsed, 'parsed', parse['degradedNote'] if parse['degraded'] else None,
            )
            reviews = raise_reviews(user, plan_id, low_confidence, all_items, file, include_parse=file_hash not in parse_reviewed)
            parse_reviewed.add(file_hash)

            day_count = len(parsed.get('days') or [])
            report.append({'user': user['id'], 'file': file, 'status': 'degraded' if parse['degraded'] else 'parsed',
                           'days': day_count, 'items': len(all_items), 'reviews': reviews, 'traceId': parse['traceId']})
            degraded = ' (degraded — served from cache)' if parse['degraded'] else ''
            log(f'  → {day_count} days, {len(all_items)} items, {reviews} for dietitian review{degraded}')
        except Exception as err:  # noqa: BLE001 — one bad document must not stop the others
            log(f'  ! parse failed: {err}')
            if not existing or existing['parse_status'] != 'parsed':
                seed_fallback_plan(user, file=file, reason=f'Parse failed: {str(err)[:200]}')
            report.append({'user': user['id'], 'file': file, 'status': 'failed', 'error': str(err), 'items': 0, 'reviews': 0})

    # Safety net: any user whose plan survived a reset but whose dated entries
    # did not gets re-expanded.
    for user in users:
        if get_row('SELECT COUNT(*) AS n FROM plan_entries WHERE user_id = ?', user['id'])['n'] > 0:
            continue
        plan = get_row('SELECT * FROM plans WHERE user_id = ? ORDER BY id DESC LIMIT 1', user['id'])
        if plan:
            materialise_plan(user['id'], plan['id'], user['start_date'], HISTORY_DAYS + 14, force=True)

    # History last: it needs materialised plan entries to tick off.
    for user in users:
        seed_history(user)

    return report


def needs_bootstrap() -> bool:
    return get_row('SELECT COUNT(*) AS n FROM plan_entries')['n'] == 0


if __name__ == '__main__':
    summary = import_plans(force='--force' in sys.argv)
    print('\nImport summary:')
    for row in summary:
        print(' ', row)
