/**
 * Behaviour-change score narration and explainable recommendations.
 *
 * Both follow the same discipline: the engine produces the numbers and the
 * rule trail, and the model is allowed to put them into English and nothing
 * more. Every sentence it writes is anchored to a fact it was handed, which is
 * what makes the output auditable rather than merely fluent.
 */

import { all, get, json } from '../db.js';
import { callModel, jsonSchema } from '../openai.js';
import {
  behaviourScore, adherenceWindow, dayEntries, dayTotals, streak,
  daysSinceLastCheckin, today, addDays, activePlan, profileConflicts,
} from '../engine.js';

/* ------------------------- behaviour score ------------------------- */

const SCORE_SCHEMA = jsonSchema('score_narration', {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'what_is_working', 'what_to_fix', 'next_step'],
  properties: {
    headline: { type: 'string', description: 'What this score says about the user now. ≤ 14 words.' },
    what_is_working: { type: 'string', description: '≤ 15 words' },
    what_to_fix: { type: 'string', description: '≤ 15 words' },
    next_step: { type: 'string', description: 'One concrete action for the next 48 hours. ≤ 15 words.' },
  },
});

export async function narrateScore({ user }) {
  const score = behaviourScore(user.id);
  const history = scoreHistory(user.id);

  const input = `User: ${user.name}. Goal: ${user.goal}. Persona: ${user.persona}.

Score: ${score.score}/100 — ${score.band}

Components (weight × value = contribution):
${score.components.map((c) => `- ${c.label}: ${c.display} → ${c.contribution} pts of a possible ${Math.round(c.weight * 100)}`).join('\n')}

Facts:
- 7-day adherence ${Math.round(score.facts.adherence7 * 100)}%, 28-day ${Math.round(score.facts.adherence28 * 100)}%
- logged ${score.facts.loggedDays7} of the last 7 days
- streak ${score.facts.streak} days, last check-in ${score.facts.daysSinceLastCheckin ?? '—'} days ago
- ${score.facts.variety} distinct foods logged

Score over the last 6 weeks: ${history.map((h) => h.score).join(' → ')}

Explain this score to the user. Every claim must come from the facts above —
you have no other information and must not invent any.`;

  const { data, traceId, degraded, degradedNote } = await callModel({
    route: 'score.narrate',
    userId: user.id,
    system: `You explain a behaviour-change score to the person it describes.
Be direct and warm. Name the actual numbers. Never invent a fact you were not given.
Never give medical advice — the plan comes from a dietitian, not from you.
If the score is low, say so plainly and without shaming; a user who cannot trust
the number will not trust the app.`,
    input,
    format: SCORE_SCHEMA,
    effort: 'low',
    maxOutput: 1500,
  });

  return { ...score, history, narration: data, traceId, degraded, degradedNote };
}

/** Weekly score trend, recomputed from history by the same rules. */
export function scoreHistory(userId, weeks = 6) {
  const out = [];
  for (let w = weeks - 1; w >= 0; w -= 1) {
    const end = addDays(today(), -w * 7);
    out.push({ week: `-${w}w`, date: end, score: behaviourScore(userId, end).score });
  }
  return out;
}

/* --------------------- explainable recommendation ------------------ */

const EXPLAIN_SCHEMA = jsonSchema('explanation', {
  type: 'object',
  additionalProperties: false,
  required: ['plain_language', 'why_it_matters', 'what_would_change_it', 'confidence', 'caveat'],
  properties: {
    plain_language: { type: 'string', description: 'Why this item is in the plan. ≤ 30 words, plain words.' },
    why_it_matters: { type: 'string', description: 'Link to this user\'s goal or condition. ≤ 18 words.' },
    what_would_change_it: { type: 'string', description: 'What would make the plan say something different. ≤ 18 words.' },
    confidence: { type: 'number' },
    caveat: { type: ['string', 'null'], description: '≤ 12 words. Null if none.' },
  },
});

/**
 * Explain one plan entry. The rule trail is assembled deterministically first,
 * and the model may only render what is in it.
 */
export async function explainEntry({ user, entryId }) {
  const entry = get('SELECT * FROM plan_entries WHERE id = ? AND user_id = ?', entryId, user.id);
  if (!entry) throw new Error('no such plan entry for this user');

  const plan = activePlan(user.id);
  const totals = dayTotals(user.id, entry.date);
  const sameSlot = dayEntries(user.id, entry.date).filter((e) => e.slot === entry.slot);
  const conditions = json(user.conditions_json, []);
  const allergies = json(user.allergies_json, []);
  const conflicts = profileConflicts(user, [entry]);

  // The deterministic trail. This is the auditable part; the model only narrates it.
  const trail = [
    {
      step: 'Source',
      detail: plan?.source_file
        ? `Authored by a dietitian in "${plan.source_file}", parsed on import.`
        : 'Seeded fallback plan — no source document was readable.',
    },
    {
      step: 'Slot',
      detail: `Scheduled at ${entry.slot}${entry.time_hint ? ` (${entry.time_hint})` : ''} alongside ${sameSlot.filter((s) => s.id !== entry.id).map((s) => s.name).join(', ') || 'nothing else'}.`,
    },
    {
      step: 'Quantity',
      detail: `${entry.qty ?? 1} ${entry.unit || 'serving'} as written in the plan.`,
    },
    {
      step: 'Macros',
      detail: entry.macro_source === 'estimated'
        ? `~${entry.kcal} kcal, ${entry.protein_g}g protein — ESTIMATED by the engine's food table. The source document states no macros.`
        : `${entry.kcal} kcal, ${entry.protein_g}g protein, taken from the plan document.`,
    },
    {
      step: 'Day context',
      detail: `This item is ${totals.planned.kcal ? Math.round((entry.kcal / totals.planned.kcal) * 100) : 0}% of the day's ~${totals.planned.kcal} kcal.`,
    },
    {
      step: 'Profile check',
      detail: conflicts.length
        ? `CONFLICT: ${conflicts.map((c) => c.reason).join(' ')}`
        : `Cleared against ${user.diet} diet and ${allergies.length ? `${allergies.join(', ')} allergy` : 'no recorded allergies'}.`,
    },
  ];

  const input = `User: ${user.name}, ${user.age}. Goal: ${user.goal}.
Conditions: ${conditions.join(', ') || 'none recorded'}. Diet: ${user.diet}.

Plan item: ${entry.name} — ${entry.qty ?? 1} ${entry.unit || ''} at ${entry.slot}

The engine's rule trail for this item:
${trail.map((t, i) => `${i + 1}. ${t.step}: ${t.detail}`).join('\n')}

Explain this item to the user using ONLY the trail above. If the macros are marked
ESTIMATED, your caveat must say so. If there is a CONFLICT, lead with it.`;

  const { data, traceId, degraded, degradedNote } = await callModel({
    route: 'explain.entry',
    userId: user.id,
    system: `You explain why a specific food is in someone's diet plan.

The plan was written by a human dietitian. You did not write it and you may not
second-guess it. You explain, using only the rule trail you are handed.

- Never state a number that is not in the trail.
- If a number is marked ESTIMATED, say that it is an estimate.
- No medical claims, no promises about outcomes, no dosage or supplement advice.
- If the trail shows a CONFLICT with the user's allergies or diet, that is the
  first thing you say, and you tell them a dietitian is reviewing it.
- Brief. Respect every word limit in the schema.`,
    input,
    format: EXPLAIN_SCHEMA,
    effort: 'low',
    maxOutput: 1500,
  });

  return { entry, trail, conflicts, explanation: data, traceId, degraded, degradedNote };
}

/* ----------------------------- funnel ------------------------------ */

/** Engagement-to-outcome funnel. Pure warehouse arithmetic, no model. */
export function funnel() {
  const cohorts = all('SELECT * FROM cohort_stats ORDER BY cohort, week');
  const byCohort = {};
  for (const row of cohorts) {
    (byCohort[row.cohort] ||= []).push({
      week: row.week, retained: row.retained, total: row.total,
      rate: Math.round((row.retained / row.total) * 100),
    });
  }

  const users = all('SELECT * FROM users');
  const live = users.map((u) => {
    const s = behaviourScore(u.id);
    return {
      id: u.id, name: u.name, cohort: u.cohort, avatar: u.avatar, persona: u.persona,
      score: s.score, band: s.band,
      adherence7: Math.round(s.facts.adherence7 * 100),
      loggedDays7: s.facts.loggedDays7,
      streak: s.facts.streak,
      silent: s.facts.daysSinceLastCheckin,
    };
  });

  return { cohorts: byCohort, live };
}
