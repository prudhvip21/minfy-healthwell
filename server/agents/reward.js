/**
 * Reward and streak agent.
 *
 * The streak *target* is a rule — a user at 30% adherence is not motivated by a
 * 30-day goal, and one at 90% is insulted by a 3-day one. The engine picks the
 * target; the model writes a payoff that is different every time, which is the
 * whole point of not shipping a static "+10 points".
 */

import { json } from '../db.js';
import { callModel, jsonSchema } from '../openai.js';
import { streak, adherenceWindow, behaviourScore, today, addDays } from '../engine.js';

/** Deterministic: which streak length is motivating for this user right now. */
export function streakTarget(userId) {
  const current = streak(userId);
  const adh = adherenceWindow(userId, addDays(today(), -1), 14);

  const ladder = adh < 0.35 ? [3, 5, 7]
    : adh < 0.65 ? [7, 14, 21]
      : [14, 30, 60];

  const target = ladder.find((t) => t > current) ?? ladder[ladder.length - 1];
  return {
    current,
    target,
    ladder,
    band: adh < 0.35 ? 'rebuilding' : adh < 0.65 ? 'building' : 'established',
    rationale: `14-day adherence ${Math.round(adh * 100)}% → ${adh < 0.35 ? 'short, reachable targets' : adh < 0.65 ? 'one-to-three-week targets' : 'longer targets'}.`,
  };
}

const REWARD_SCHEMA = jsonSchema('reward', {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'detail', 'tone'],
  properties: {
    headline: { type: 'string', description: '≤ 50 characters. The payoff — this is often all the user reads.' },
    detail: { type: 'string', description: '≤ 15 words, naming something specific the user did.' },
    tone: { type: 'string', description: 'celebratory, encouraging, or steady' },
  },
});

const SYSTEM = `You write the reward a user sees after logging a meal in an Indian nutrition app.

A static "+10 points" dies within a week. Yours must not read like a template.

- Name something concrete from this check-in: the actual dish, the match rate, the
  streak number, the time of day.
- Vary the shape. Sometimes a fact, sometimes praise, sometimes a small observation
  about a pattern.
- Match the tone to the situation. A user rebuilding after a lapse gets steadiness,
  not confetti. A 20-day streak gets genuine acknowledgement.
- Never mention points, badges or coins. The payoff is recognition, not currency.
- Indian English. Keep food names as they are.`;

export async function generateReward({ user, checkinResult }) {
  const target = streakTarget(user.id);
  const score = behaviourScore(user.id);

  const matched = checkinResult.matched?.map((m) => m.name) || [];
  const unplanned = checkinResult.unplanned?.map((m) => m.name) || [];

  const input = `User: ${user.name}. Persona: ${user.persona}. Goal: ${user.goal}.

This check-in (${checkinResult.slot}):
- matched the plan: ${matched.join(', ') || 'nothing'}
- off-plan: ${unplanned.join(', ') || 'nothing'}
- conflicts with their diet/allergies (dietitian notified — acknowledge gently, never scold): ${checkinResult.flagged?.map((b) => b.name).join(', ') || 'nothing'}

Streak: ${target.current} days, next target ${target.target} (${target.band}).
Behaviour score: ${score.score} (${score.band}).

Write the reward.`;

  const { data, traceId, degraded, degradedNote } = await callModel({
    route: 'reward.message',
    userId: user.id,
    system: SYSTEM,
    input,
    format: REWARD_SCHEMA,
    effort: 'minimal',       // highest-volume route in the system
    verbosity: 'low',
    maxOutput: 800,
  });

  return { ...data, streak: target, score: score.score, traceId, degraded, degradedNote };
}
