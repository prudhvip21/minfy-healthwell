"""
Plan-change and readjustment loop.

The agent only ever produces a *proposal*. engine.validate_swap scores it,
engine.gate decides its fate, and engine.apply_swap is the single write path. A
proposal the engine dislikes goes to a dietitian however confident the model was.
"""

from __future__ import annotations

from ..db import all_rows, from_json, get_row, insert, run
from ..engine import AUTO_APPLY_THRESHOLD, add_days, apply_swap, day_entries, day_totals, gate, today, validate_swap
from ..guardrails import scan_items, verdict_record
from ..llm import call_model, json_schema
from ..util import iso_now, js_number, js_round, num

SWAP_SCHEMA = json_schema('plan_adjustment', {
    'type': 'object',
    'additionalProperties': False,
    'required': ['rationale', 'dietitian_summary', 'user_message', 'confidence', 'remove_entry_ids', 'move_items', 'add_items'],
    'properties': {
        'rationale': {'type': 'string', 'description': 'For the dietitian: why this adjustment. ≤ 25 words.'},
        'dietitian_summary': {'type': 'string', 'description': 'Handover note for the dietitian: what the user ate, what went off-plan, and what you changed. ≤ 45 words.'},
        'user_message': {'type': 'string', 'description': 'For the user: one warm sentence, ≤ 18 words. No blame.'},
        'confidence': {'type': 'number', 'description': '0-1. How sure are you this is the right adjustment?'},
        'remove_entry_ids': {
            'type': 'array',
            'items': {'type': 'integer'},
            'description': 'plan_entry ids to drop entirely, chosen from the candidates given',
        },
        'move_items': {
            'type': 'array',
            'description': 'Untouched dishes worth keeping — moved to a later day instead of dropped',
            'items': {
                'type': 'object',
                'additionalProperties': False,
                'required': ['entry_id', 'to_date', 'why'],
                'properties': {
                    'entry_id': {'type': 'integer'},
                    'to_date': {'type': 'string', 'description': 'YYYY-MM-DD, a future day from the list given'},
                    'why': {'type': 'string', 'description': '≤ 12 words'},
                },
            },
        },
        'add_items': {
            'type': 'array',
            'items': {
                'type': 'object',
                'additionalProperties': False,
                'required': ['name', 'qty', 'unit', 'slot', 'why'],
                'properties': {
                    'name': {'type': 'string'},
                    'qty': {'type': ['number', 'null']},
                    'unit': {'type': ['string', 'null']},
                    'slot': {'type': 'string'},
                    'why': {'type': 'string', 'description': '≤ 12 words'},
                },
            },
        },
    },
})

SYSTEM = """You rebalance an Indian diet plan after a user has eaten something off-plan.

You do not decide anything. You propose, and a deterministic rules engine then
checks your proposal against the user's calorie budget, allergies and diet. If
the engine objects, a human dietitian reviews it. Propose accordingly:

- Prefer the smallest change that works. Removing one item usually beats
  rebuilding the day.
- Compensate within the SAME day where possible, and only in later meals — never
  retroactively change a meal the user has already eaten.
- MOVE rather than drop when a dish is untouched and would be a direct
  replacement on a later day — the same slot, a similar dish already planned
  there, and nothing perishable about it. Moving keeps the dietitian's intent;
  dropping throws it away. Drop only what cannot sensibly be eaten later.
- Never move or remove anything the user has already eaten.
- Respect the user's diet and allergies absolutely. Never propose a food that
  conflicts with them; the engine will block it and the proposal will be wasted.
- Keep the plan culturally coherent. Replace rice with millet or roti, not quinoa.
- Be honest in "confidence". Below 0.85 sends this to a dietitian, which is the
  correct outcome when the right answer is genuinely unclear.
- "user_message" never scolds. The user ate something. That is information, not a
  failure."""


def _qty(v) -> str:
    return num(v if v is not None else 1)


def propose_adjustment(user: dict, date: str | None = None, unplanned: list | None = None, trigger: str = 'checkin') -> dict:
    """Build a proposal for off-plan eating; apply it if the engine allows, else queue it for a dietitian."""
    d = date or today()
    entries = day_entries(user['id'], d)
    remaining = [e for e in entries if e['status'] in ('planned', 'added')]
    eaten = [e for e in entries if e['status'] == 'eaten']

    # When no off-plan list is supplied, read it off the day itself — that is
    # what "readjust my plan" means: look at what actually happened today.
    if unplanned:
        off_plan = unplanned
    else:
        off_plan = [{'name': e['name'], 'qty': e['qty'], 'unit': e['unit'], 'kcal': e['kcal'], 'flag': e.get('flag')}
                    for e in entries if e['status'] == 'offplan']

    totals = day_totals(user['id'], d)

    def remaining_line(e):
        return (f"- id {e['id']}: {e['name']} — {_qty(e['qty'])} {e['unit'] or ''} "
                f"({e['slot']}, ~{js_round(js_number(e['kcal']))} kcal est.)")

    def off_plan_line(u):
        kcal = num(u['kcal']) if u.get('kcal') is not None else '?'
        flag = f" [{u['flag']}]" if u.get('flag') else ''
        return f"- {u.get('name')} ({_qty(u.get('qty'))} {u.get('unit') or 'serving'}, ~{kcal} kcal est.){flag}"

    # The next few days, so a move can be judged a genuine replacement.
    upcoming_lines = []
    for n in (1, 2, 3):
        day = add_days(d, n)
        names = '; '.join(f"{e['slot']} — {e['name']}" for e in day_entries(user['id'], day) if e['status'] == 'planned')
        upcoming_lines.append(f"{day}: {names or '(nothing planned)'}")
    upcoming = '\n'.join(upcoming_lines)

    conditions = ', '.join(from_json(user.get('conditions_json'), [])) or 'none recorded'
    allergies = ', '.join(from_json(user.get('allergies_json'), [])) or 'none recorded'
    off_plan_kcal = f", of which {num(totals['offPlanKcal'])} kcal was off-plan" if totals['offPlanKcal'] else ''
    eaten_text = '\n'.join(f"- {e['name']} ({e['slot']})" for e in eaten) or '- nothing yet'
    off_text = '\n'.join(off_plan_line(u) for u in off_plan) if off_plan else '- nothing off-plan'
    remaining_text = '\n'.join(remaining_line(e) for e in remaining) if remaining else '- (nothing left in the day)'

    prompt = (
        f"User: {user['name']}, {user['age']}, {user['sex']}. Goal: {user['goal']}.\n"
        f"Conditions: {conditions}.\n"
        f"Diet: {user['diet']}. Allergies: {allergies}.\n\n"
        f"Date: {d}. Trigger: {trigger}.\n"
        f"Day so far: {num(totals['consumed']['kcal'])} kcal eaten of ~{num(totals['planned']['kcal'])} planned{off_plan_kcal}.\n\n"
        f"Already eaten today (never touch these):\n{eaten_text}\n\n"
        f"Eaten off-plan:\n{off_text}\n\n"
        f"Still to come today — you may remove these, or move them to a later day (use these ids exactly):\n{remaining_text}\n\n"
        f"Planned for the next few days, for judging whether a move is a direct replacement:\n{upcoming}\n\n"
        "Propose the adjustment."
    )

    res = call_model(
        route='planswap.propose',
        user_id=user['id'],
        system=SYSTEM,
        input=prompt,
        format=SWAP_SCHEMA,
        # The engine re-checks every number, so the agent needs judgment, not
        # depth. Reasoning tokens count against the cap on GPT-5 — leave headroom.
        effort='low',
        max_output=12000,
    )
    data = res['data']

    # ---- engine takes over ----

    proposal = {
        'date': d,
        'removals': data.get('remove_entry_ids') or [],
        'moves': [{'entry_id': m.get('entry_id'), 'to_date': m.get('to_date'), 'why': m.get('why')}
                  for m in data.get('move_items') or []],
        'additions': [{'name': a.get('name'), 'qty': a['qty'] if a.get('qty') is not None else 1,
                       'unit': a.get('unit'), 'slot': a.get('slot'), 'notes': a.get('why')}
                      for a in data.get('add_items') or []],
    }

    validation = validate_swap(user, proposal)
    gate_out = scan_items(user, validation['additions'])
    decision = gate(validation, data['confidence'] if data.get('confidence') is not None else 0)

    change_id = insert('plan_changes', {
        'user_id': user['id'],
        'kind': 'swap',
        'summary': _summarise(validation, data),
        'proposal_json': {
            **proposal,
            'rationale': data.get('rationale'),
            'dietitian_summary': data.get('dietitian_summary'),
            'user_message': data.get('user_message'),
            'trigger': trigger,
        },
        'engine_json': {
            'delta': validation['delta'],
            'kcalDriftPct': validation['kcalDriftPct'],
            'reasons': validation['reasons'],
            'conflicts': validation['conflicts'],
            'removals': [{'id': r['id'], 'name': r['name'], 'kcal': r['kcal']} for r in validation['removals']],
            'moves': [{'id': m['entry']['id'], 'name': m['entry']['name'], 'slot': m['entry']['slot'],
                       'kcal': m['entry']['kcal'], 'to': m['to']} for m in validation['moves']],
            'additions': [{'name': a['name'], 'qty': a['qty'], 'unit': a.get('unit'), 'slot': a['slot'],
                           'kcal': a['kcal'], 'macro_source': a['macro_source']} for a in validation['additions']],
            'threshold': AUTO_APPLY_THRESHOLD,
        },
        'confidence': data.get('confidence'),
        'status': decision['decision'],
        'reason': decision['reason'],
        'trace_id': res['traceId'],
        'decided_at': iso_now() if decision['decision'] == 'auto_applied' else None,
    })

    if decision['decision'] == 'auto_applied':
        apply_swap(user, validation)
        insert('events', {'user_id': user['id'], 'type': 'plan_auto_adjusted',
                          'payload_json': {'changeId': change_id, 'delta': validation['delta']}})
    else:
        insert('events', {'user_id': user['id'], 'type': f"plan_change_{decision['decision']}",
                          'payload_json': {'changeId': change_id}})

    return {
        'changeId': change_id,
        'decision': decision['decision'],
        'reason': decision['reason'],
        'confidence': data.get('confidence'),
        'rationale': data.get('rationale'),
        'dietitianSummary': data.get('dietitian_summary'),
        'userMessage': data.get('user_message'),
        'validation': validation,
        'guardrails': verdict_record(None, gate_out),
        'traceId': res['traceId'],
        'degraded': res['degraded'],
        'degradedNote': res.get('degradedNote'),
    }


def _summarise(validation: dict, data: dict) -> str:
    parts = []
    if validation['removals']:
        parts.append(f"drop {', '.join(r['name'] for r in validation['removals'])}")
    if validation['moves']:
        parts.append(f"move {', '.join(m['entry']['name'] + ' → ' + m['to'] for m in validation['moves'])}")
    if validation['additions']:
        parts.append(f"add {', '.join(a['name'] for a in validation['additions'])}")
    if not parts:
        return (data.get('rationale') or '')[:80] or 'No change proposed'
    s = ' · '.join(parts)
    return s[0].upper() + s[1:]


def decide(change_id: int, decision: str, reviewer: str | None = None) -> dict:
    """Dietitian decision on a queued proposal — the other write path into plans."""
    reviewer = reviewer if reviewer is not None else 'Dietitian (demo)'
    change = get_row('SELECT * FROM plan_changes WHERE id = ?', change_id)
    if not change:
        raise ValueError(f'no such change {change_id}')
    if change['status'] != 'pending':
        raise ValueError(f"change {change_id} is already {change['status']}")

    user = get_row('SELECT * FROM users WHERE id = ?', change['user_id'])

    if decision == 'approved':
        if change['kind'] == 'swap':
            proposal = from_json(change['proposal_json'], {})
            # Re-validate at approval time: the day may have moved on since the
            # proposal was made, and the engine's answer is the one that counts.
            validation = validate_swap(user, proposal)
            if not validation['valid']:
                run("UPDATE plan_changes SET status = 'rejected', reason = ?, reviewer = ?, decided_at = datetime('now') WHERE id = ?",
                    f"Re-validated at approval and refused: {' '.join(b['reason'] for b in validation['blocking'])}",
                    reviewer, change_id)
                return {'status': 'rejected', 'reason': 'Engine refused the change at approval time.', 'validation': validation}
            apply_swap(user, validation)
        run("UPDATE plan_changes SET status = 'approved', reviewer = ?, decided_at = datetime('now') WHERE id = ?",
            reviewer, change_id)
        insert('events', {'user_id': user['id'], 'type': 'plan_change_approved',
                          'payload_json': {'changeId': change_id, 'reviewer': reviewer}})
        return {'status': 'approved'}

    run("UPDATE plan_changes SET status = 'rejected', reviewer = ?, decided_at = datetime('now') WHERE id = ?",
        reviewer, change_id)
    insert('events', {'user_id': user['id'], 'type': 'plan_change_rejected',
                      'payload_json': {'changeId': change_id, 'reviewer': reviewer}})
    return {'status': 'rejected'}


def review_queue(user_id: str | None = None) -> list:
    if user_id:
        rows = all_rows("SELECT * FROM plan_changes WHERE user_id = ? ORDER BY (status='pending') DESC, id DESC", user_id)
    else:
        rows = all_rows("SELECT * FROM plan_changes ORDER BY (status='pending') DESC, id DESC")
    return [{**r, 'proposal': from_json(r['proposal_json'], {}), 'engine': from_json(r['engine_json'], None)} for r in rows]
