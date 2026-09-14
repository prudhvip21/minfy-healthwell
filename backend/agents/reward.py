"""
Reward and streak agent.

The streak *target* is a rule — a user at 30% adherence is not motivated by a
30-day goal, and one at 90% is insulted by a 3-day one. The engine picks the
target; the model writes a payoff that is different every time, which is the
whole point of not shipping a static "+10 points".
"""

from __future__ import annotations

from ..engine import add_days, adherence_window, behaviour_score, streak, today
from ..llm import call_model, json_schema
from ..util import js_round


def streak_target(user_id: str) -> dict:
    """Deterministic: which streak length is motivating for this user right now."""
    current = streak(user_id)
    adh = adherence_window(user_id, add_days(today(), -1), 14)

    if adh < 0.35:
        ladder, band, style = [3, 5, 7], 'rebuilding', 'short, reachable targets'
    elif adh < 0.65:
        ladder, band, style = [7, 14, 21], 'building', 'one-to-three-week targets'
    else:
        ladder, band, style = [14, 30, 60], 'established', 'longer targets'

    target = next((t for t in ladder if t > current), ladder[-1])
    return {
        'current': current,
        'target': target,
        'ladder': ladder,
        'band': band,
        'rationale': f'14-day adherence {js_round(adh * 100)}% → {style}.',
    }


REWARD_SCHEMA = json_schema('reward', {
    'type': 'object',
    'additionalProperties': False,
    'required': ['headline', 'detail', 'tone'],
    'properties': {
        'headline': {'type': 'string', 'description': '≤ 50 characters. The payoff — this is often all the user reads.'},
        'detail': {'type': 'string', 'description': '≤ 15 words, naming something specific the user did.'},
        'tone': {'type': 'string', 'description': 'celebratory, encouraging, or steady'},
    },
})

SYSTEM = """You write the reward a user sees after logging a meal in an Indian nutrition app.

A static "+10 points" dies within a week. Yours must not read like a template.

- Name something concrete from this check-in: the actual dish, the match rate, the
  streak number, the time of day.
- Vary the shape. Sometimes a fact, sometimes praise, sometimes a small observation
  about a pattern.
- Match the tone to the situation. A user rebuilding after a lapse gets steadiness,
  not confetti. A 20-day streak gets genuine acknowledgement.
- Never mention points, badges or coins. The payoff is recognition, not currency.
- Indian English. Keep food names as they are."""


def generate_reward(user: dict, checkin_result: dict) -> dict:
    target = streak_target(user['id'])
    score = behaviour_score(user['id'])

    matched = ', '.join(m['name'] for m in checkin_result.get('matched') or []) or 'nothing'
    unplanned = ', '.join(m['name'] for m in checkin_result.get('unplanned') or []) or 'nothing'
    flagged = ', '.join(b['name'] for b in checkin_result.get('flagged') or []) or 'nothing'

    prompt = (
        f"User: {user['name']}. Persona: {user['persona']}. Goal: {user['goal']}.\n\n"
        f"This check-in ({checkin_result.get('slot')}):\n"
        f"- matched the plan: {matched}\n"
        f"- off-plan: {unplanned}\n"
        f"- conflicts with their diet/allergies (dietitian notified — acknowledge gently, never scold): {flagged}\n\n"
        f"Streak: {target['current']} days, next target {target['target']} ({target['band']}).\n"
        f"Behaviour score: {score['score']} ({score['band']}).\n\n"
        'Write the reward.'
    )

    res = call_model(
        route='reward.message',
        user_id=user['id'],
        system=SYSTEM,
        input=prompt,
        format=REWARD_SCHEMA,
        effort='minimal',     # highest-volume route in the system
        verbosity='low',
        max_output=800,
    )
    return {**res['data'], 'streak': target, 'score': score['score'],
            'traceId': res['traceId'], 'degraded': res['degraded'], 'degradedNote': res.get('degradedNote')}
