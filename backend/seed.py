"""
Demo users and their history.

The three personas are chosen against the contents of the real dietitian
document in plans/: one user it suits cleanly, one whose allergy and diet
collide with specific items in it, and one who has stopped logging. Between
them every screen has a story that needs no explaining.
"""

from __future__ import annotations

import math

from .db import all_rows, get_row, insert, run
from .engine import add_days, day_entries, today
from .util import js_round

PERSONAS = [
    {
        'id': 'ananya', 'name': 'Ananya Sharma', 'age': 32, 'sex': 'F',
        'goal': 'Fat loss with PCOS management',
        'conditions_json': ['PCOS', 'Insulin resistance'],
        'diet': 'lacto-vegetarian', 'allergies_json': ['peanut'],
        'persona': 'High adherer, logs every day', 'cohort': 'Feb-2026', 'avatar': '🌿',
        # Climbing: 0.62 -> 0.95 across the window, logs every day.
        'curve': lambda i, n: {'adherence': 0.62 + (0.33 * i) / (n - 1), 'logs': True},
    },
    {
        'id': 'rohit', 'name': 'Rohit Menon', 'age': 41, 'sex': 'M',
        'goal': 'Pre-diabetes reversal (HbA1c 6.1)',
        'conditions_json': ['Pre-diabetic', 'Hypertension'],
        'diet': 'non-vegetarian', 'allergies_json': [],
        'persona': 'Mid adherer, travels, eats off-plan', 'cohort': 'Feb-2026', 'avatar': '✈️',
        # Sawtooth around 0.55, misses roughly two days a week.
        'curve': lambda i, n: {'adherence': 0.4 + 0.3 * abs(math.sin(i * 1.1)), 'logs': i % 7 != 2 and i % 7 != 5},
    },
    {
        'id': 'meera', 'name': 'Meera Iyer', 'age': 27, 'sex': 'F',
        'goal': 'Weight maintenance and energy',
        'conditions_json': ['Lactose intolerance', 'Low ferritin'],
        'diet': 'vegetarian', 'allergies_json': ['dairy'],
        'persona': 'Strong start, silent for 6 days', 'cohort': 'Jan-2026', 'avatar': '🌙',
        # Good for two weeks, then stops entirely. n-5 puts her last check-in
        # 6 days ago, matching the persona label.
        'curve': lambda i, n: ({'adherence': 0.85 - 0.02 * i, 'logs': True} if i < n - 5
                               else {'adherence': 0, 'logs': False}),
    },
]

HISTORY_DAYS = 21

_USER_FIELDS = ('id', 'name', 'age', 'sex', 'goal', 'conditions_json', 'diet', 'allergies_json', 'persona', 'cohort', 'avatar')


def ensure_users() -> list:
    if get_row('SELECT COUNT(*) AS n FROM users')['n'] > 0:
        return all_rows('SELECT * FROM users')

    start = add_days(today(), -(HISTORY_DAYS - 1))
    for p in PERSONAS:
        insert('users', {**{k: p[k] for k in _USER_FIELDS}, 'start_date': start})
    return all_rows('SELECT * FROM users')


def seed_history(user: dict) -> int:
    """
    Walk the materialised plan and mark items eaten according to the persona's
    curve, writing the check-ins and events that would have produced them.
    Everything downstream — adherence, score, nudges, funnel — reads this.
    """
    persona = next((p for p in PERSONAS if p['id'] == user['id']), None)
    if not persona:
        return 0
    if get_row('SELECT COUNT(*) AS n FROM checkins WHERE user_id = ?', user['id'])['n'] > 0:
        return 0

    n = HISTORY_DAYS
    written = 0
    for i in range(n):
        # i = 0 is the oldest day; the window ends yesterday.
        d = add_days(today(), -(n - i))
        curve = persona['curve'](i, n)
        if not curve['logs'] or curve['adherence'] <= 0:
            continue

        entries = day_entries(user['id'], d)
        if not entries:
            continue

        take = max(1, js_round(len(entries) * curve['adherence']))
        eaten = entries[:take]

        checkin_id = insert('checkins', {
            'user_id': user['id'], 'date': d, 'slot': None,
            'modality': 'photo' if i % 3 == 0 else 'voice' if i % 3 == 1 else 'text',
            'raw_text': f'Seeded history — {take} of {len(entries)} planned items',
            'created_at': f'{d} 20:30:00',
        })

        for e in eaten:
            run("UPDATE plan_entries SET status = 'eaten' WHERE id = ?", e['id'])
            insert('checkin_items', {
                'checkin_id': checkin_id, 'user_id': user['id'], 'name': e['name'], 'qty': e['qty'], 'unit': e['unit'],
                'kcal': e['kcal'], 'protein_g': e['protein_g'], 'carbs_g': e['carbs_g'], 'fat_g': e['fat_g'],
                'confidence': 0.9, 'verdict': 'matched', 'matched_entry_id': e['id'],
            })

        # Off-plan meals are Rohit's defining behaviour — they drive the swap loop.
        if user['id'] == 'rohit' and i % 4 == 3:
            off_plan = ['Chicken biryani - 1.5 cup', 'Masala dosa - 2no', 'Filter coffee with sugar - 1cup'][i % 3]
            insert('checkin_items', {
                'checkin_id': checkin_id, 'user_id': user['id'], 'name': off_plan, 'qty': 1, 'unit': 'serving',
                'kcal': 480, 'protein_g': 18, 'carbs_g': 62, 'fat_g': 17,
                'confidence': 0.82, 'verdict': 'unplanned',
            })

        insert('events', {
            'user_id': user['id'], 'type': 'checkin',
            'payload_json': {'date': d, 'items': take, 'adherence': js_round(curve['adherence'] * 100) / 100},
            'ts': f'{d} 20:30:00',
        })
        written += 1

    insert('events', {
        'user_id': user['id'], 'type': 'onboarded',
        'payload_json': {'cohort': user['cohort']},
        'ts': f"{user['start_date']} 09:00:00",
    })
    return written


def seed_cohort_stats() -> None:
    """Synthetic warehouse rows so the funnel isn't three data points wide."""
    if get_row('SELECT COUNT(*) AS n FROM cohort_stats')['n'] > 0:
        return
    cohorts = [
        ('Dec-2025', 412, [1, 0.58, 0.41, 0.33]),
        ('Jan-2026', 486, [1, 0.61, 0.44, 0.36]),
        ('Feb-2026', 523, [1, 0.64, 0.48, 0.39]),
    ]
    for cohort, total, retention in cohorts:
        for week, r in enumerate(retention, start=1):
            insert('cohort_stats', {'cohort': cohort, 'week': week, 'retained': js_round(total * r), 'total': total})


def seed_partners() -> None:
    if get_row('SELECT COUNT(*) AS n FROM partners')['n'] > 0:
        return
    insert('partners', {
        'id': 'healthwise', 'name': 'HealthWise (first party)',
        'brand_json': {'primary': '#00B15D', 'logo': '🌱'},
        'enabled_json': ['checkin', 'planloop', 'nudges', 'assistant', 'score', 'explain'],
        'rate_limit': 10000, 'active': 1,
    })
    insert('partners', {
        'id': 'apollo', 'name': 'Apollo Wellness (white label)',
        'brand_json': {'primary': '#1B6CC4', 'logo': '🏥'},
        'enabled_json': ['checkin', 'planloop', 'explain'],
        'rate_limit': 2000, 'active': 0,
    })
    insert('partners', {
        'id': 'corpfit', 'name': 'CorpFit Employee Benefits',
        'brand_json': {'primary': '#7A3FBF', 'logo': '🏢'},
        'enabled_json': ['checkin', 'nudges', 'score'],
        'rate_limit': 500, 'active': 0,
    })
