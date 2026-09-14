"""
The rules engine. Deterministic, no model calls, no network.

Everything an agent wants to change to a user's plan passes through here
first. Agents produce proposals; this module decides whether a proposal is
valid, what it costs in macros, and whether it may be applied without a
dietitian. If you want to know what the AI is not allowed to do, read this
file — it is the whole answer.
"""

from __future__ import annotations

import math
import re
from datetime import date as _date, datetime, timedelta, timezone

from .db import all_rows, from_json, get_row, insert, run
from .util import js_number, js_round, num, round1

# Canonical meal slots, in the order a day runs.
SLOTS = ['Wake up', 'Breakfast', 'Mid-Morning', 'Lunch', 'Snack', 'Post Exercise', 'Dinner', 'Post Dinner']
_SLOT_INDEX = {s: i for i, s in enumerate(SLOTS)}

SLOT_ALIASES = {
    'wake up meal': 'Wake up', 'wake-up': 'Wake up', 'wakeup': 'Wake up',
    'early morning': 'Wake up', 'on waking': 'Wake up',
    'break fast': 'Breakfast', 'morning': 'Breakfast',
    'mid morning': 'Mid-Morning', 'midmorning': 'Mid-Morning',
    'mid-evening': 'Snack', 'evening snack': 'Snack', 'evening': 'Snack',
    'post workout': 'Post Exercise', 'post-workout': 'Post Exercise',
    'post exercise': 'Post Exercise', 'pre exercise': 'Post Exercise',
    'post dinner': 'Post Dinner', 'bed time': 'Post Dinner', 'bedtime': 'Post Dinner',
}


def normalise_slot(raw) -> str:
    if not raw:
        return 'Snack'
    k = re.sub(r'\s+', ' ', re.sub(r'[^a-z ]', ' ', str(raw).lower())).strip()
    if k in SLOT_ALIASES:
        return SLOT_ALIASES[k]
    exact = next((s for s in SLOTS if s.lower() == k), None)
    return exact or next((s for s in SLOTS if s.lower() in k), None) or 'Snack'


# --------------------------------------------------------------------------
# Name normalisation and matching
# --------------------------------------------------------------------------

_NOISE = re.compile(
    r'\b(add|of|with|or|and|no|nos|cup|cups|tsp|tbsp|glass|handful|piece|pieces|bowl'
    r'|small|medium|large|boiled|roasted|stir|fry|fried|raw|fresh)\b'
)


def normalise_name(s) -> str:
    s = str(s or '').lower()
    s = re.sub(r'\(.*?\)', ' ', s)          # drop parenthetical asides
    s = re.sub(r'[0-9./]+', ' ', s)         # drop quantities
    s = re.sub(r'[^a-z\s]', ' ', s)
    s = _NOISE.sub(' ', s)
    s = re.sub(r'\s+', ' ', s)
    return s.strip()


# Regional and spelling variants that name the same food.
SYNONYMS = {
    'pappu': 'dal', 'daal': 'dal', 'dhal': 'dal', 'paruppu': 'dal',
    'raitha': 'raita', 'dahi': 'curd', 'thayir': 'curd', 'perugu': 'curd',
    'chapati': 'roti', 'chapathi': 'roti', 'phulka': 'roti', 'fulka': 'roti',
    'chaas': 'buttermilk', 'majjiga': 'buttermilk', 'mor': 'buttermilk',
    'chai': 'tea', 'badam': 'almond', 'kishmish': 'raisin', 'pista': 'pistachio',
    'bendakaya': 'okra', 'bhindi': 'okra', 'ladyfinger': 'okra',
    'thotakura': 'amaranth', 'putnallu': 'gram',
}


def _singular(t: str) -> str:
    """'chapatis' -> 'chapati', 'idlis' -> 'idli'; leaves 'glass'-style words alone."""
    return t[:-1] if len(t) > 3 and t.endswith('s') and not t.endswith('ss') else t


def _tokens(s) -> set:
    out = set()
    for t in normalise_name(s).split(' '):
        if len(t) > 2:
            t = _singular(t)
            out.add(SYNONYMS.get(t, t))
    return out


def similarity(a, b) -> float:
    """
    Containment-weighted token overlap. Deliberately not a fuzzy string
    distance: "tomato dal" vs "tomato pappu" should match on the shared head
    noun, while "brown rice" vs "white rice" should not score high enough to
    auto-apply.
    """
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0
    shared = sum(1 for t in ta if t in tb)
    if not shared:
        return 0
    return shared / min(len(ta), len(tb)) * (shared / max(len(ta), len(tb))) ** 0.5


MATCH_THRESHOLD = 0.5


def find_match(logged_name, entries):
    """Best plan entry for a logged item, or None. Never mutates."""
    best, best_score = None, 0
    for e in entries:
        s = similarity(logged_name, e['name'])
        if s > best_score:
            best_score, best = s, e
    return {'entry': best, 'score': best_score} if best_score >= MATCH_THRESHOLD else None


# --------------------------------------------------------------------------
# Profile conflicts — allergies and diet, checked against any item list.
# Used at plan import AND at every check-in. A hard gate: it does not consult
# a model and a model cannot overrule it.
# --------------------------------------------------------------------------

ALLERGEN_TERMS = {
    'peanut': {
        'severity': 'high',
        'terms': ['peanut', 'peanuts', 'groundnut', 'ground nut', 'moongphali', 'mungfali', 'palli', 'peanut butter'],
    },
    'treenut': {
        'severity': 'high',
        'terms': ['almond', 'cashew', 'walnut', 'pista', 'pistachio', 'brazilnut', 'brazil nut', 'hazelnut', 'badam'],
    },
    'dairy': {
        'severity': 'high',
        'terms': ['milk', 'curd', 'yoghurt', 'yogurt', 'buttermilk', 'raitha', 'raita', 'paneer', 'cheese', 'lassi',
                  'khoya', 'cream', 'butter'],
        # Ghee is dairy but effectively lactose-free; flag it, don't alarm over it.
        'low': ['ghee'],
    },
    'gluten': {'severity': 'high', 'terms': ['wheat', 'roti', 'chapati', 'bread', 'atta', 'maida', 'suji', 'rava', 'poori']},
    'egg': {'severity': 'high', 'terms': ['egg', 'omelette', 'omelet', 'anda']},
    'soy': {'severity': 'high', 'terms': ['soy', 'soya', 'tofu']},
    'shellfish': {'severity': 'high', 'terms': ['prawn', 'shrimp', 'crab', 'lobster']},
}

# What each diet forbids.
DIET_FORBIDS = {
    'vegan': ['dairy', 'egg', 'meat'],
    'vegetarian': ['egg', 'meat'],
    'lacto-vegetarian': ['egg', 'meat'],
    'ovo-vegetarian': ['meat'],
    'eggetarian': ['meat'],
}

MEAT_TERMS = ['chicken', 'mutton', 'fish', 'prawn', 'meat', 'non veg', 'nonveg', 'beef', 'pork', 'lamb', 'egg']


def _has_term(text, terms):
    n = f' {normalise_name(text)} '
    return next((t for t in terms if f' {t} ' in n or f' {t}s ' in n), None)


def profile_conflicts(user: dict, items: list) -> list:
    allergies = [str(a).lower() for a in from_json(user.get('allergies_json'), [])]
    diet = str(user.get('diet') or '').lower()
    forbids = DIET_FORBIDS.get(diet, [])
    out: list = []

    for item in items:
        name = (item.get('name') or item) if isinstance(item, dict) else item
        notes = item.get('notes') if isinstance(item, dict) else None
        # Allergens hide in preparation notes ("add 1tsp of ghee", "garnish with
        # peanuts"), so the check reads the name and the notes together.
        text = ' '.join(str(x) for x in (name, notes) if x)

        for allergy in allergies:
            group = ALLERGEN_TERMS.get(allergy)
            if not group:
                continue
            hit = _has_term(text, group['terms'])
            if hit:
                out.append({
                    'item': name, 'kind': 'allergy', 'allergen': allergy, 'severity': group['severity'], 'matched': hit,
                    'reason': f'Contains {hit} — user profile records a {allergy} allergy.',
                })
                continue
            low_hit = _has_term(text, group['low']) if group.get('low') else None
            if low_hit:
                out.append({
                    'item': name, 'kind': 'allergy', 'allergen': allergy, 'severity': 'low', 'matched': low_hit,
                    'reason': f"Contains {low_hit}. Derived from {allergy} but usually tolerated — worth a dietitian's confirmation.",
                })

        for f in forbids:
            terms = MEAT_TERMS if f == 'meat' else ALLERGEN_TERMS.get(f, {}).get('terms', [])
            hit = _has_term(text, terms)
            if hit and not any(c['item'] == name and c['matched'] == hit for c in out):
                out.append({
                    'item': name, 'kind': 'diet', 'allergen': f, 'severity': 'high', 'matched': hit,
                    'reason': f"Contains {hit}, which the user's {diet} diet excludes.",
                })
    return out


# --------------------------------------------------------------------------
# Macro estimation. The dietitian's document states no macros at all, so every
# number in this app is an estimate and is labelled 'estimated' wherever shown.
#
# Values are per ONE of the unit the plan uses for that food: per piece for
# idli, roti, egg and individual nuts; per cup for rice, dal, curry, curd; per
# tbsp for chutney; per glass for drinks. Optional unit overrides cover foods
# also measured by plate or handful. Order matters — first match wins, so
# compound names ("Cucumber, Banana, smoothie") must hit the specific entry.
# --------------------------------------------------------------------------

def _m(kcal, protein_g, carbs_g, fat_g):
    return {'kcal': kcal, 'protein_g': protein_g, 'carbs_g': carbs_g, 'fat_g': fat_g}


_FOOD_TABLE_RAW = [
    (r'smoothie', _m(150, 2.5, 28, 4), None),
    (r'chamomile|green tea|warm water|\bwater\b', _m(2, 0, 0, 0), None),
    # Common off-plan foods — what people actually report when they eat off-plan.
    (r'biryani|pulao|pulav', _m(290, 11, 38, 10),
     {'plate': _m(580, 22, 76, 20), 'serving': _m(450, 17, 59, 16), 'bowl': _m(450, 17, 59, 16)}),
    (r'samosa', _m(260, 4, 30, 14), None),
    (r'gulab jamun|jalebi|rasgulla|laddu|barfi|halwa|sweet', _m(150, 2, 24, 6), None),
    (r'lassi', _m(260, 8, 40, 7), None),
    (r'coke|cola|pepsi|soft drink|soda|sprite|fanta', _m(100, 0, 26, 0),
     {'can': _m(140, 0, 39, 0), 'bottle': _m(210, 0, 55, 0)}),
    (r'paratha', _m(260, 6, 36, 10), None),
    (r'puri|poori|bhatura', _m(100, 1.5, 12, 5), None),
    (r'vada|bonda|pakora|bajji|bhajji', _m(130, 4, 14, 7), None),
    (r'pizza', _m(285, 12, 36, 10), None),
    (r'burger', _m(450, 20, 45, 20), None),
    (r'chips|namkeen|mixture|bhujia', _m(150, 2, 15, 10), None),
    (r'ice cream|kulfi', _m(140, 2.5, 17, 7), None),
    (r'paneer', _m(270, 17, 6, 20), None),
    (r'buttermilk|chaas', _m(40, 2, 4, 1.5), None),
    (r'raitha|raita', _m(120, 5, 9, 7), None),
    (r'curd|yoghurt|yogurt|dahi', _m(150, 8.5, 11, 8), None),
    (r'idli', _m(58, 1.6, 12, 0.4), None),
    (r'dosa', _m(133, 2.7, 22, 3.7), None),
    (r'roti|chapati|phulka', _m(104, 3.1, 20, 1.5), None),
    (r'rice', _m(205, 4.3, 45, 0.4), None),
    (r'poha', _m(180, 3.5, 35, 3), None),
    (r'dal|pappu|sambar', _m(150, 9, 22, 3), None),
    (r'rasam', _m(60, 2, 9, 2), None),
    (r'ghee', _m(45, 0, 0, 5), None),
    (r'\boil\b', _m(40, 0, 0, 4.5), None),
    (r'chutney', _m(55, 1, 3, 4.5), None),
    # Individual nuts and dried fruit — per piece, which is how plans count them.
    (r'almond|badam', _m(7, 0.26, 0.25, 0.6), {'handful': _m(165, 6, 6, 14)}),
    (r'cashew', _m(9, 0.3, 0.5, 0.7), {'handful': _m(160, 5, 9, 13)}),
    (r'walnut', _m(13, 0.3, 0.3, 1.3), {'handful': _m(185, 4.3, 3.9, 18.5)}),
    (r'pista|pistachio', _m(4, 0.15, 0.2, 0.3), {'handful': _m(160, 6, 8, 13)}),
    (r'brazil', _m(33, 0.7, 0.6, 3.4), None),
    (r'raisin|kishmish', _m(2, 0, 0.5, 0), {'handful': _m(130, 1.4, 34, 0.2)}),
    (r'prune', _m(20, 0.2, 5.4, 0), None),
    (r'date', _m(23, 0.2, 6, 0), None),
    (r'peanut|groundnut', _m(6, 0.26, 0.2, 0.5), {'handful': _m(170, 7.5, 5, 14)}),
    (r'putnallu|roasted gram|chana', _m(4, 0.2, 0.6, 0.1), {'handful': _m(110, 6.5, 18, 1.8)}),
    (r'sprout', _m(100, 7, 16, 0.6), None),
    (r'egg', _m(78, 6.3, 0.6, 5.3), None),
    (r'chicken|mutton|fish|non veg|nonveg|meat', _m(250, 25, 6, 14), None),
    (r'curry|sabzi|bendakaya|chikudikaya|cabbage|capsicum|vegetable', _m(130, 3, 12, 8), None),
    (r'salad|cucumber|carrot|beetroot', _m(45, 1.5, 8, 0.5), None),
    (r'fruit|banana|apple|papaya|pomegranate|orange|guava', _m(90, 1, 22, 0.3), None),
    (r'tea|coffee', _m(40, 1.2, 5, 1.5), None),
]
FOOD_TABLE = [(re.compile(p), macros, overrides) for p, macros, overrides in _FOOD_TABLE_RAW]
_UNKNOWN_FOOD = _m(80, 2, 10, 3)


def estimate_macros(name, qty=1, unit=None) -> dict:
    """Rough macros for an item when neither the plan nor the model supplied any."""
    n = normalise_name(name)
    hit = next((row for row in FOOD_TABLE if row[0].search(n)), None)
    by_unit = None
    if hit and hit[2] and unit:
        by_unit = hit[2].get(re.sub(r's$', '', str(unit).lower()))
    base = by_unit or (hit[1] if hit else _UNKNOWN_FOOD)
    q = js_number(qty)
    q = q if q > 0 else 1
    return {
        'kcal': round1(base['kcal'] * q), 'protein_g': round1(base['protein_g'] * q),
        'carbs_g': round1(base['carbs_g'] * q), 'fat_g': round1(base['fat_g'] * q),
        'macro_source': 'estimated',
    }


def with_macros(item: dict) -> dict:
    """Fill any missing macro on an item, marking where the numbers came from."""
    missing = any(item.get(k) is None or item.get(k) == '' for k in ('kcal', 'protein_g', 'carbs_g', 'fat_g'))
    if not missing:
        return {**item, 'macro_source': item.get('macro_source') or 'plan'}
    return {**item, **estimate_macros(item.get('name'), item.get('qty'), item.get('unit'))}


# --------------------------------------------------------------------------
# Dates. Kept in UTC, as the original service did.
# --------------------------------------------------------------------------

def iso_date(d) -> str:
    if isinstance(d, (_date, datetime)):
        return d.isoformat()[:10]
    return str(d)[:10]


def add_days(d, n: int) -> str:
    return (_date.fromisoformat(iso_date(d)) + timedelta(days=n)).isoformat()


def today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


# --------------------------------------------------------------------------
# Materialisation — expand the authored day cycle onto calendar dates.
# --------------------------------------------------------------------------

def materialise_plan(user_id: str, plan_id: int, start_date: str, days: int = 28, force: bool = False) -> int:
    """
    Write plan_entries for `days` calendar days from `start_date`, cycling
    through the plan's authored days. Idempotent per date unless `force`.
    """
    if not get_row('SELECT * FROM plans WHERE id = ?', plan_id):
        raise ValueError(f'no plan {plan_id}')

    cycle = all_rows('SELECT * FROM plan_days WHERE plan_id = ? ORDER BY day_index', plan_id)
    if not cycle:
        return 0
    items_by_day = {d['id']: all_rows('SELECT * FROM plan_items WHERE plan_day_id = ? ORDER BY id', d['id']) for d in cycle}

    written = 0
    for i in range(days):
        d = add_days(start_date, i)
        if get_row('SELECT COUNT(*) AS n FROM plan_entries WHERE user_id = ? AND date = ?', user_id, d)['n'] > 0:
            if not force:
                continue
            run('DELETE FROM plan_entries WHERE user_id = ? AND date = ?', user_id, d)
        day = cycle[i % len(cycle)]
        for item in items_by_day[day['id']]:
            m = with_macros(item)
            insert('plan_entries', {
                'user_id': user_id, 'date': d, 'slot': item['slot'], 'time_hint': item['time_hint'],
                'plan_item_id': item['id'], 'name': item['name'], 'qty': item['qty'], 'unit': item['unit'],
                'kcal': m['kcal'], 'protein_g': m['protein_g'], 'carbs_g': m['carbs_g'], 'fat_g': m['fat_g'],
                'macro_source': m['macro_source'], 'status': 'planned',
            })
            written += 1
    return written


# --------------------------------------------------------------------------
# Daily rollups
#
# Entry statuses:
#   planned  on the plan, not yet eaten
#   eaten    on the plan, ticked off by a check-in
#   added    put on the plan by an approved swap
#   swapped  taken off the plan by an approved swap
#   offplan  eaten, but never on the plan — a fact the user reported
# --------------------------------------------------------------------------

ON_PLAN = {'planned', 'eaten', 'added', 'missed'}
CONSUMED = {'eaten', 'offplan'}


def day_entries(user_id: str, d: str) -> list:
    rows = all_rows('SELECT * FROM plan_entries WHERE user_id = ? AND date = ? ORDER BY id', user_id, d)
    return sorted(rows, key=lambda r: _SLOT_INDEX.get(r['slot'], -1))


def _sum(rows, k) -> float:
    total = 0
    for r in rows:
        total = total + (r.get(k) or 0)
    return round1(total)


def day_totals(user_id: str, d: str) -> dict:
    entries = day_entries(user_id, d)
    plan = [e for e in entries if e['status'] in ON_PLAN]
    eaten = [e for e in entries if e['status'] in CONSUMED]
    off = [e for e in entries if e['status'] == 'offplan']
    return {
        'planned': {'kcal': _sum(plan, 'kcal'), 'protein_g': _sum(plan, 'protein_g'),
                    'carbs_g': _sum(plan, 'carbs_g'), 'fat_g': _sum(plan, 'fat_g')},
        'consumed': {'kcal': _sum(eaten, 'kcal'), 'protein_g': _sum(eaten, 'protein_g'),
                     'carbs_g': _sum(eaten, 'carbs_g'), 'fat_g': _sum(eaten, 'fat_g')},
        'offPlanKcal': _sum(off, 'kcal'),
        'items': len(plan),
        'eaten': len(eaten),
        'estimated': any(e['macro_source'] == 'estimated' for e in entries),
    }


def day_adherence(user_id: str, d: str):
    """Share of planned items ticked off for one date. Off-plan food doesn't count either way."""
    entries = [e for e in day_entries(user_id, d) if e['status'] in ON_PLAN]
    if not entries:
        return None
    return sum(1 for e in entries if e['status'] == 'eaten') / len(entries)


def adherence_window(user_id: str, end_date: str, days: int = 7) -> float:
    scores = []
    for i in range(days):
        a = day_adherence(user_id, add_days(end_date, -i))
        if a is not None:
            scores.append(a)
    if not scores:
        return 0
    total = 0
    for s in scores:
        total = total + s
    return total / len(scores)


def streak(user_id: str, end_date: str | None = None) -> int:
    """Consecutive days ending today with at least one check-in. Today not yet logged doesn't break it."""
    end_date = end_date or today()
    n = 0
    for i in range(400):
        d = add_days(end_date, -i)
        if get_row('SELECT COUNT(*) AS n FROM checkins WHERE user_id = ? AND date = ?', user_id, d)['n'] > 0:
            n += 1
        elif i > 0:
            break
    return n


def days_since_last_checkin(user_id: str, end_date: str | None = None):
    end_date = end_date or today()
    row = get_row('SELECT MAX(date) AS d FROM checkins WHERE user_id = ?', user_id)
    if not row or not row['d']:
        return None
    return (_date.fromisoformat(end_date) - _date.fromisoformat(row['d'][:10])).days


# --------------------------------------------------------------------------
# Applying change — the only write path into plan_entries.
# --------------------------------------------------------------------------

AUTO_APPLY_THRESHOLD = 0.85


def _to_id(v):
    n = js_number(v)
    return int(n) if math.isfinite(n) else None


def _sum_of(rows, k) -> float:
    total = 0
    for r in rows:
        n = js_number(r.get(k))
        total = total + (0 if math.isnan(n) else n)
    return total


def validate_swap(user: dict, proposal: dict) -> dict:
    """
    Validate a swap proposal without applying it: the macro delta and every
    reason the engine would refuse or escalate. Pure — no writes.
    """
    d = proposal.get('date') or today()
    entries = day_entries(user['id'], d)
    by_id = {e['id']: e for e in entries}

    def movable(e):
        return bool(e) and e['status'] in ('planned', 'added')

    # Moves push an untouched dish to a later day instead of wasting it.
    horizon = add_days(today(), 14)
    moves = []
    for mv in proposal.get('moves') or []:
        raw = mv.get('entry_id') if mv.get('entry_id') is not None else mv.get('entryId')
        entry = by_id.get(_to_id(raw))
        to = mv.get('to_date') or mv.get('toDate')
        if not movable(entry) or not to:
            continue
        if to <= d or to > horizon:          # forward only, inside the plan horizon
            continue
        moves.append({'entry': entry, 'to': to})

    removals = [by_id.get(_to_id(i)) for i in proposal.get('removals') or []]
    removals = [e for e in removals if movable(e)]
    additions = [with_macros({**a, 'slot': normalise_slot(a.get('slot')),
                              'qty': a['qty'] if a.get('qty') is not None else 1})
                 for a in proposal.get('additions') or []]

    conflicts = profile_conflicts(user, additions)
    blocking = [c for c in conflicts if c['severity'] == 'high']

    # A moved item leaves today just as a removed one does.
    gone = removals + [m['entry'] for m in moves]
    delta = {k: round1(_sum_of(additions, k) - _sum_of(gone, k)) for k in ('kcal', 'protein_g', 'carbs_g', 'fat_g')}

    targets = from_json(plan_targets(user['id']), {})
    day_kcal = day_totals(user['id'], d)['planned']['kcal']
    budget = targets.get('kcal') or day_kcal or 1800
    kcal_drift_pct = abs(delta['kcal']) / budget if budget else 0

    reasons = [c['reason'] for c in blocking]
    if kcal_drift_pct > 0.15:
        sign = '+' if delta['kcal'] > 0 else ''
        reasons.append(
            f"Swap moves the day by {sign}{num(delta['kcal'])} kcal ({js_round(kcal_drift_pct * 100)}% of the day's budget), "
            'past the 15% auto-apply limit.'
        )
    if not additions and not removals and not moves:
        reasons.append('Proposal changes nothing.')
    if any(a['macro_source'] == 'estimated' for a in additions):
        reasons.append('Macros for one or more added items are estimated, not from the plan.')

    return {
        'date': d, 'removals': removals, 'additions': additions, 'moves': moves, 'delta': delta,
        'conflicts': conflicts, 'blocking': blocking,
        'kcalDriftPct': round1(kcal_drift_pct * 100) / 100,
        'valid': not blocking,
        'reasons': reasons,
    }


def gate(validation: dict, confidence: float) -> dict:
    """
    Decide a proposal's fate. Hard conflicts are refused outright — model
    confidence is irrelevant to them. Otherwise confidence and the engine's
    own objections decide auto-apply versus dietitian review.
    """
    if not validation['valid']:
        return {'decision': 'rejected', 'reason': ' '.join(c['reason'] for c in validation['blocking'])}
    if confidence >= AUTO_APPLY_THRESHOLD and not validation['reasons']:
        return {'decision': 'auto_applied', 'reason': f'Confidence {js_round(confidence * 100)}% and no engine objections.'}
    return {
        'decision': 'pending',
        'reason': ' '.join(validation['reasons']) if validation['reasons']
        else f'Confidence {js_round(confidence * 100)}% is below the {num(AUTO_APPLY_THRESHOLD * 100)}% auto-apply threshold.',
    }


def apply_swap(user: dict, validation: dict) -> list:
    """Apply a validated swap. Call only after gate() says so."""
    for e in validation['removals']:
        run("UPDATE plan_entries SET status = 'swapped' WHERE id = ?", e['id'])

    # Moves: off today's plate, onto the target day.
    for mv in validation.get('moves') or []:
        entry, to = mv['entry'], mv['to']
        run("UPDATE plan_entries SET status = 'swapped' WHERE id = ?", entry['id'])
        insert('plan_entries', {
            'user_id': user['id'], 'date': to, 'slot': entry['slot'], 'time_hint': entry['time_hint'],
            'plan_item_id': entry['plan_item_id'], 'name': entry['name'], 'qty': entry['qty'], 'unit': entry['unit'],
            'kcal': entry['kcal'], 'protein_g': entry['protein_g'], 'carbs_g': entry['carbs_g'], 'fat_g': entry['fat_g'],
            'macro_source': entry['macro_source'], 'status': 'planned',
            'swapped_from': f"moved from {validation['date']}",
        })

    ids = []
    for a in validation['additions']:
        ids.append(insert('plan_entries', {
            'user_id': user['id'], 'date': validation['date'], 'slot': a['slot'], 'time_hint': a.get('time_hint'),
            'name': a['name'], 'qty': a['qty'], 'unit': a.get('unit') or None,
            'kcal': a['kcal'], 'protein_g': a['protein_g'], 'carbs_g': a['carbs_g'], 'fat_g': a['fat_g'],
            'macro_source': a['macro_source'], 'status': 'added',
            'swapped_from': ', '.join(r['name'] for r in validation['removals']) or None,
        }))
    return ids


def mark_eaten(entry_id: int) -> None:
    """Mark a planned entry eaten. The only place status becomes 'eaten'."""
    run("UPDATE plan_entries SET status = 'eaten' WHERE id = ?", entry_id)


def record_off_plan(user_id: str, d: str, slot, item: dict, flag: str | None = None) -> int:
    """
    Record food the user ate that was not on the plan. A fact, not a plan
    change: shown on the day in its own colour and counted towards
    consumption, never towards the plan or adherence. `flag` carries any
    conflict with the user's diet or allergies.
    """
    m = with_macros(item)
    return insert('plan_entries', {
        'user_id': user_id, 'date': d, 'slot': normalise_slot(slot), 'time_hint': None,
        'name': item['name'], 'qty': item['qty'] if item.get('qty') is not None else 1, 'unit': item.get('unit') or None,
        'kcal': m['kcal'], 'protein_g': m['protein_g'], 'carbs_g': m['carbs_g'], 'fat_g': m['fat_g'],
        'macro_source': m['macro_source'], 'status': 'offplan', 'flag': flag,
    })


def plan_targets(user_id: str):
    row = get_row('SELECT targets_json FROM plans WHERE user_id = ? ORDER BY id DESC LIMIT 1', user_id)
    return row['targets_json'] if row else '{}'


def active_plan(user_id: str):
    return get_row('SELECT * FROM plans WHERE user_id = ? ORDER BY id DESC LIMIT 1', user_id)


# --------------------------------------------------------------------------
# Behaviour change score — rules and arithmetic only. The model is allowed to
# narrate it, never to compute it.
# --------------------------------------------------------------------------

def _clamp01(n) -> float:
    n = n if isinstance(n, (int, float)) and math.isfinite(n) else 0
    return max(0, min(1, n))


def _trend_label(a7: float, a28: float) -> str:
    d = js_round((a7 - a28) * 100)
    if d > 5:
        return f'up {d}'
    if d < -5:
        return f'down {abs(d)}'
    return 'steady'


def behaviour_score(user_id: str, end_date: str | None = None) -> dict:
    end_date = end_date or today()
    # Today is still in progress — scoring a partially eaten day as a miss would
    # punish every user every morning. Windows end yesterday; streak and silence
    # are still measured from today.
    window_end = add_days(end_date, -1)

    adh7 = adherence_window(user_id, window_end, 7)
    adh28 = adherence_window(user_id, window_end, 28)
    logged7 = get_row(
        'SELECT COUNT(DISTINCT date) AS n FROM checkins WHERE user_id = ? AND date > ? AND date <= ?',
        user_id, add_days(window_end, -7), window_end,
    )['n']
    st = streak(user_id, end_date)
    since = days_since_last_checkin(user_id, end_date)

    # Momentum: the 7-day rate against the 28-day one. Steady sits at half marks;
    # a 25-point swing either way reaches the ends.
    momentum = _clamp01(0.5 + (adh7 - adh28) * 2)

    # Four components, each of which moves with what the user does. "Dietary
    # variety" was dropped: against a repeating plan it measured the
    # dietitian's plan, not the person, and scored full marks for everyone.
    components = [
        {'key': 'adherence', 'label': 'Plan adherence', 'weight': 0.45, 'value': adh7,
         'display': f'{js_round(adh7 * 100)}%', 'detail': 'of planned items eaten, last 7 days'},
        {'key': 'consistency', 'label': 'Logging consistency', 'weight': 0.30, 'value': logged7 / 7,
         'display': f'{logged7} of 7 days', 'detail': 'days with at least one check-in'},
        # A fixed scale, so the number means the same thing for every user. The
        # personal milestone ladder is separate: scoring against a moving target
        # would drop a user's score the moment they reached a milestone.
        {'key': 'streak', 'label': 'Current streak', 'weight': 0.15, 'value': min(st / 21, 1),
         'display': '1 day' if st == 1 else f'{st} days', 'detail': 'scored out of 21 unbroken days'},
        {'key': 'momentum', 'label': 'Momentum', 'weight': 0.10, 'value': momentum,
         'display': _trend_label(adh7, adh28), 'detail': 'this week vs the 28-day average; steady is half marks'},
    ]

    # The score is the sum of the points shown, not a separately rounded total,
    # so the parts on screen always add up to the headline.
    scored = [{**c, 'max': js_round(c['weight'] * 100), 'contribution': js_round(c['weight'] * _clamp01(c['value']) * 100)}
              for c in components]
    score = sum(c['contribution'] for c in scored)

    # Lapsed is about recency, not arithmetic.
    if since is not None and since >= 5:
        band = 'Lapsed'
    elif score >= 75:
        band = 'Strong'
    elif score >= 50:
        band = 'Building'
    elif score >= 25:
        band = 'At risk'
    else:
        band = 'Lapsed'

    return {
        'score': score,
        'band': band,
        'components': scored,
        'facts': {'adherence7': adh7, 'adherence28': adh28, 'loggedDays7': logged7,
                  'streak': st, 'daysSinceLastCheckin': since},
    }
