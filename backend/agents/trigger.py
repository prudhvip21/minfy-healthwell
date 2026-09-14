"""
Trigger agent — re-engagement nudges.

The engine decides WHO and in WHAT REGISTER: drop-off signals and the tone band
are rules over adherence. The model decides only the words and the moment. Every
message can be traced back to the band and signal behind it.
"""

from __future__ import annotations

import math

from ..db import all_rows, from_json, get_row, insert, run
from ..engine import add_days, adherence_window, behaviour_score, day_entries, days_since_last_checkin, streak, today
from ..llm import call_model, json_schema
from ..util import js_round

# Tone bands, chosen by 7-day adherence. A rule, not a model judgement — whether
# a user gets a playful nudge or an offer of a human call must be predictable.
TONE_BANDS = [
    {
        'key': 'reach_out', 'below': 0.10, 'label': 'Reach out', 'range': '< 10%',
        'brief': ('Something may genuinely be wrong. Every message is about the PERSON, not the plan — none asks them '
                  'to log food. Sound like a human who noticed and cares. The first message asks if they are okay and '
                  'offers a call from their Relationship Manager (a real person). The others hold the door open '
                  'gently: no pressure, no deadline, it is fine to come back whenever.'),
        'register': "Haven't heard from you in a while — is everything okay? Your RM would be happy to call.",
        'escalate': True,
    },
    {
        'key': 'restart', 'below': 0.30, 'label': 'Restart', 'range': '10–30%',
        'brief': ('It has been hard, and EVERY message acknowledges that in its own way before anything else. Lower the '
                  'bar to one small thing, and make today a clean slate — no catching up, no looking back.'),
        'register': "I know it's hard to log. Let's not look back — just start again today, with one meal.",
    },
    {
        'key': 'nudge', 'below': 0.70, 'label': 'Nudge', 'range': '30–70%',
        'brief': 'Slipping but still here. Light, curious, a little playful, zero pressure. Make coming back feel effortless and worth it.',
        'register': 'Busy day? Your plan is still here, no judgement — two taps and today counts.',
    },
    {
        'key': 'celebrate', 'below': math.inf, 'label': 'Celebrate', 'range': '≥ 70%',
        'brief': ('They are doing the work. Be genuinely proud of them — about who they are becoming, not the menu. '
                  'Playful, warm, protective of the streak without making it a chore.'),
        'register': "Three weeks in a row. That's not luck any more — that's who you are now.",
    },
]


def tone_band(adherence7: float) -> dict:
    return next(b for b in TONE_BANDS if adherence7 < b['below'])


def _public_band(band: dict) -> dict:
    """JSON has no infinity; the top band's open upper bound goes out as null."""
    return {**band, 'below': None if math.isinf(band['below']) else band['below']}


def detect_signals(user: dict, adherence_override: float | None = None) -> dict:
    """Deterministic drop-off detection. No model involved."""
    silent = days_since_last_checkin(user['id'])
    real_adh7 = adherence_window(user['id'], add_days(today(), -1), 7)
    adh7 = adherence_override if adherence_override is not None else real_adh7
    adh28 = adherence_window(user['id'], add_days(today(), -1), 28)
    st = streak(user['id'])
    score = behaviour_score(user['id'])

    signals = []
    if silent is None:
        signals.append({'key': 'never_logged', 'severity': 'high', 'detail': 'No check-in ever recorded.'})
    elif silent >= 5:
        signals.append({'key': 'lapsed', 'severity': 'high', 'detail': f'{silent} days since the last check-in.'})
    elif silent >= 2:
        signals.append({'key': 'slipping', 'severity': 'medium', 'detail': f'{silent} days since the last check-in.'})

    if adh7 < 0.3:
        signals.append({'key': 'low_adherence', 'severity': 'high', 'detail': f'7-day adherence {js_round(adh7 * 100)}%.'})
    if adh7 < adh28 - 0.1:
        signals.append({'key': 'declining', 'severity': 'medium', 'detail': f'Down {js_round((adh28 - adh7) * 100)} pts vs 28-day.'})
    if st >= 7:
        signals.append({'key': 'streak_live', 'severity': 'low', 'detail': f'{st}-day streak.'})
    if not any(e['status'] == 'eaten' for e in day_entries(user['id'], today())):
        signals.append({'key': 'today_unlogged', 'severity': 'low', 'detail': 'Nothing logged today.'})

    cohort = get_row('SELECT * FROM cohort_stats WHERE cohort = ? AND week = 2', user['cohort'])

    return {
        'silent': silent, 'adherence7': adh7, 'realAdherence7': real_adh7, 'adherence28': adh28, 'streak': st,
        'simulated': adherence_override is not None,
        'score': score['score'], 'band': score['band'],
        'tone': _public_band(tone_band(adh7)),
        'cohort': user['cohort'],
        'cohortWeek2Retention': cohort['retained'] / cohort['total'] if cohort else None,
        'signals': signals,
    }


NUDGE_SCHEMA = json_schema('nudges', {
    'type': 'object',
    'additionalProperties': False,
    'required': ['nudges'],
    'properties': {
        'nudges': {
            'type': 'array',
            'items': {
                'type': 'object',
                'additionalProperties': False,
                'required': ['channel', 'send_at_local', 'title', 'body', 'cta', 'angle', 'why'],
                'properties': {
                    'channel': {'type': 'string', 'description': 'push or whatsapp'},
                    'send_at_local': {'type': 'string', 'description': 'HH:MM, 24h, user local time'},
                    'title': {'type': 'string', 'description': '≤ 40 characters'},
                    'body': {'type': 'string', 'description': '≤ 110 characters; must not repeat the title'},
                    'cta': {'type': 'string', 'description': '2–5 words, a one-tap action'},
                    'angle': {'type': 'string', 'description': 'question | offer | reframe | celebration | check-in'},
                    'why': {'type': 'string', 'description': 'One short line for the team: why this message at this time'},
                },
            },
        },
    },
})

SYSTEM = """You write push and WhatsApp messages for HealthWise, an Indian nutrition coaching app.
Your only job: make one specific person want to open the app today.

The rules engine has already chosen a TONE BAND from this person's adherence. You do
not choose it and you do not second-guess it. You write the best possible messages
inside it. The band brief and a sample register are given with each request — match
the register, never copy the sample.

Craft:
- Every message in the set carries the band's emotional register — not just one of them.
- Motivation, not logistics. Write about the person: their effort, their momentum, how
  today could feel. This is not a menu readout. Mention at most one food per message,
  lightly, and never list plan items.
- Subtle beats loud. A good nudge reads like a message from a friend who happens to
  know nutrition, not a notification from an app.
- Never lead with a statistic. Percentages, scores and day counts are for your
  understanding; the person should feel noticed, not measured. Use a number only if
  it is a win worth celebrating, like a streak.
- Anchor in something real: their goal, the time of day, the streak, the fact that
  they have gone quiet, or one dish they will recognise.
- Never give dietary instructions, swaps or substitutions — that is the dietitian's job.
- Each message in the set takes a different angle — a question, a gentle offer, a
  reframe. Never three rewordings of one sentence.
- Title ≤ 40 characters, body ≤ 110. The body continues the title; it never repeats it.
- Warm, human Indian English. Food names stay as they are. One emoji in the whole set
  at most, and only if it truly belongs. No stacked exclamation marks.
- Never shame or guilt. Never use "failed", "missed", "behind", "should", "don't forget".
- No medical advice or health claims.
- CTA: 2–5 words, one tap. In the REACH OUT band, the first message's CTA offers the
  call with their RM (e.g. "Call me back", "Talk to my RM"), and no CTA in that band
  asks them to log anything.
- Timing: meal nudges shortly before the meal (breakfast 08:30, lunch 12:45, dinner
  19:45); reflective or check-in messages around 20:30. Never before 07:00 or after 21:30.
- Use the first name at most once across the whole set."""


def generate_nudges(user: dict, count: int = 3, adherence_override: float | None = None) -> dict:
    s = detect_signals(user, adherence_override=adherence_override)
    band = s['tone']
    todays = day_entries(user['id'], today())

    meal_lines = []
    for slot in ('Breakfast', 'Lunch', 'Dinner'):
        items = [e for e in todays if e['slot'] == slot]
        if items:
            meal_lines.append(f"{slot} ({items[0]['time_hint'] or ''}): {', '.join(e['name'] for e in items)}")
    meals = '\n'.join(meal_lines)

    conditions = ', '.join(from_json(user.get('conditions_json'), [])) or 'none'
    silent = s['silent'] if s['silent'] is not None else 'never'
    simulated = ' (what-if preview)' if s['simulated'] else ''
    signal_keys = ', '.join(x['key'] for x in s['signals']) or 'none'

    prompt = (
        f"TONE BAND: {band['label'].upper()} (7-day adherence {band['range']})\n"
        f"Brief: {band['brief']}\n"
        f"Sample register (do not copy): \"{band['register']}\"\n\n"
        f"Person: {user['name'].split(' ')[0]}, {user['age']}. Goal: {user['goal']}.\n"
        f"Diet: {user['diet']}. Conditions: {conditions}.\n"
        'Context the engine computed (for you, not for the message):\n'
        f'- days since last check-in: {silent}\n'
        f"- current streak: {s['streak']} days\n"
        f"- 7-day adherence: {js_round(s['adherence7'] * 100)}%{simulated}\n"
        f'- signals: {signal_keys}\n\n'
        f"Today's plan:\n{meals or '(nothing scheduled)'}\n\n"
        f'Write {count} messages.'
    )

    res = call_model(
        route='trigger.nudges',
        user_id=user['id'],
        system=SYSTEM,
        input=prompt,
        format=NUDGE_SCHEMA,
        effort='low',
        verbosity='low',
        max_output=6000,
    )

    ids = []
    for n in res['data'].get('nudges') or []:
        ids.append(insert('nudges', {
            'user_id': user['id'],
            'channel': n.get('channel'),
            'send_at': n.get('send_at_local'),
            'copy': n.get('body'),
            'rationale_json': {
                'title': n.get('title'), 'cta': n.get('cta'), 'angle': n.get('angle'), 'why': n.get('why'),
                'band': band['key'], 'band_label': band['label'], 'escalate': bool(band.get('escalate')),
                'simulated': s['simulated'], 'adherence7': s['adherence7'],
            },
            'cohort': user['cohort'],
            'status': 'queued',
            'trace_id': res['traceId'],
        }))

    return {'signals': s, 'nudges': list_nudges(user['id']), 'ids': ids,
            'traceId': res['traceId'], 'degraded': res['degraded'], 'degradedNote': res.get('degradedNote')}


def list_nudges(user_id: str) -> list:
    return [{**n, 'rationale': from_json(n['rationale_json'], {})}
            for n in all_rows('SELECT * FROM nudges WHERE user_id = ? ORDER BY id DESC', user_id)]


def mark_nudge(nudge_id: int, status: str) -> dict:
    row = get_row('SELECT * FROM nudges WHERE id = ?', nudge_id)
    if not row:
        raise ValueError('no such nudge')
    run('UPDATE nudges SET status = ? WHERE id = ?', status, nudge_id)
    insert('events', {
        'user_id': row['user_id'],
        'type': 'rm_callback_requested' if status == 'escalated' else f'nudge_{status}',
        'payload_json': {'id': nudge_id},
    })
    return {**get_row('SELECT * FROM nudges WHERE id = ?', nudge_id), 'rationale': from_json(row['rationale_json'], {})}
