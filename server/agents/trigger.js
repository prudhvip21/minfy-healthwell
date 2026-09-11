/**
 * Trigger agent — re-engagement nudges.
 *
 * The engine decides WHO and in WHAT REGISTER: drop-off signals and the tone
 * band are rules over adherence. The model decides only the words and the
 * moment. Every message can be traced back to the band and signal behind it.
 */

import { all, get, insert, run, json } from '../db.js';
import { callModel, jsonSchema } from '../openai.js';
import {
  daysSinceLastCheckin, adherenceWindow, streak, behaviourScore,
  dayEntries, today, addDays,
} from '../engine.js';

/**
 * Tone bands, chosen by 7-day adherence. A rule, not a model judgement —
 * whether a user gets a playful nudge or an offer of a human call must be
 * predictable and auditable.
 */
export const TONE_BANDS = [
  {
    key: 'reach_out', below: 0.10, label: 'Reach out', range: '< 10%',
    brief: 'Something may genuinely be wrong. Every message is about the PERSON, not the plan — none asks them to log food. Sound like a human who noticed and cares. The first message asks if they are okay and offers a call from their Relationship Manager (a real person). The others hold the door open gently: no pressure, no deadline, it is fine to come back whenever.',
    register: "Haven't heard from you in a while — is everything okay? Your RM would be happy to call.",
    escalate: true,
  },
  {
    key: 'restart', below: 0.30, label: 'Restart', range: '10–30%',
    brief: 'It has been hard, and EVERY message acknowledges that in its own way before anything else. Lower the bar to one small thing, and make today a clean slate — no catching up, no looking back.',
    register: "I know it's hard to log. Let's not look back — just start again today, with one meal.",
  },
  {
    key: 'nudge', below: 0.70, label: 'Nudge', range: '30–70%',
    brief: 'Slipping but still here. Light, curious, a little playful, zero pressure. Make coming back feel effortless and worth it.',
    register: 'Busy day? Your plan is still here, no judgement — two taps and today counts.',
  },
  {
    key: 'celebrate', below: Infinity, label: 'Celebrate', range: '≥ 70%',
    brief: 'They are doing the work. Be genuinely proud of them — about who they are becoming, not the menu. Playful, warm, protective of the streak without making it a chore.',
    register: "Three weeks in a row. That's not luck any more — that's who you are now.",
  },
];

export function toneBand(adherence7) {
  return TONE_BANDS.find((b) => adherence7 < b.below);
}

/** Deterministic drop-off detection. No model involved. */
export function detectSignals(user, { adherenceOverride = null } = {}) {
  const silent = daysSinceLastCheckin(user.id);
  const realAdh7 = adherenceWindow(user.id, addDays(today(), -1), 7);
  const adh7 = adherenceOverride ?? realAdh7;
  const adh28 = adherenceWindow(user.id, addDays(today(), -1), 28);
  const st = streak(user.id);
  const score = behaviourScore(user.id);

  const signals = [];
  if (silent === null) signals.push({ key: 'never_logged', severity: 'high', detail: 'No check-in ever recorded.' });
  else if (silent >= 5) signals.push({ key: 'lapsed', severity: 'high', detail: `${silent} days since the last check-in.` });
  else if (silent >= 2) signals.push({ key: 'slipping', severity: 'medium', detail: `${silent} days since the last check-in.` });

  if (adh7 < 0.3) signals.push({ key: 'low_adherence', severity: 'high', detail: `7-day adherence ${Math.round(adh7 * 100)}%.` });
  if (adh7 < adh28 - 0.1) signals.push({ key: 'declining', severity: 'medium', detail: `Down ${Math.round((adh28 - adh7) * 100)} pts vs 28-day.` });
  if (st >= 7) signals.push({ key: 'streak_live', severity: 'low', detail: `${st}-day streak.` });
  if (!dayEntries(user.id, today()).some((e) => e.status === 'eaten')) {
    signals.push({ key: 'today_unlogged', severity: 'low', detail: 'Nothing logged today.' });
  }

  const cohort = get('SELECT * FROM cohort_stats WHERE cohort = ? AND week = 2', user.cohort);

  return {
    silent, adherence7: adh7, realAdherence7: realAdh7, adherence28: adh28, streak: st,
    simulated: adherenceOverride !== null,
    score: score.score, band: score.band,
    tone: toneBand(adh7),
    cohort: user.cohort, cohortWeek2Retention: cohort ? cohort.retained / cohort.total : null,
    signals,
  };
}

const NUDGE_SCHEMA = jsonSchema('nudges', {
  type: 'object',
  additionalProperties: false,
  required: ['nudges'],
  properties: {
    nudges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['channel', 'send_at_local', 'title', 'body', 'cta', 'angle', 'why'],
        properties: {
          channel: { type: 'string', description: 'push or whatsapp' },
          send_at_local: { type: 'string', description: 'HH:MM, 24h, user local time' },
          title: { type: 'string', description: '≤ 40 characters' },
          body: { type: 'string', description: '≤ 110 characters; must not repeat the title' },
          cta: { type: 'string', description: '2–5 words, a one-tap action' },
          angle: { type: 'string', description: 'question | offer | reframe | celebration | check-in' },
          why: { type: 'string', description: 'One short line for the team: why this message at this time' },
        },
      },
    },
  },
});

const SYSTEM = `You write push and WhatsApp messages for HealthWise, an Indian nutrition coaching app.
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
- Use the first name at most once across the whole set.`;

export async function generateNudges({ user, count = 3, adherenceOverride = null }) {
  const s = detectSignals(user, { adherenceOverride });
  const band = s.tone;
  const todays = dayEntries(user.id, today());
  const meals = ['Breakfast', 'Lunch', 'Dinner']
    .map((slot) => {
      const items = todays.filter((e) => e.slot === slot);
      return items.length ? `${slot} (${items[0].time_hint || ''}): ${items.map((e) => e.name).join(', ')}` : null;
    })
    .filter(Boolean).join('\n');

  const input = `TONE BAND: ${band.label.toUpperCase()} (7-day adherence ${band.range})
Brief: ${band.brief}
Sample register (do not copy): "${band.register}"

Person: ${user.name.split(' ')[0]}, ${user.age}. Goal: ${user.goal}.
Diet: ${user.diet}. Conditions: ${json(user.conditions_json, []).join(', ') || 'none'}.
Context the engine computed (for you, not for the message):
- days since last check-in: ${s.silent ?? 'never'}
- current streak: ${s.streak} days
- 7-day adherence: ${Math.round(s.adherence7 * 100)}%${s.simulated ? ' (what-if preview)' : ''}
- signals: ${s.signals.map((x) => x.key).join(', ') || 'none'}

Today's plan:
${meals || '(nothing scheduled)'}

Write ${count} messages.`;

  const { data, traceId, degraded, degradedNote } = await callModel({
    route: 'trigger.nudges',
    userId: user.id,
    system: SYSTEM,
    input,
    format: NUDGE_SCHEMA,
    effort: 'low',
    verbosity: 'low',
    maxOutput: 6000,
  });

  const ids = [];
  for (const n of data.nudges || []) {
    ids.push(insert('nudges', {
      user_id: user.id,
      channel: n.channel,
      send_at: n.send_at_local,
      copy: n.body,
      rationale_json: {
        title: n.title, cta: n.cta, angle: n.angle, why: n.why,
        band: band.key, band_label: band.label, escalate: Boolean(band.escalate),
        simulated: s.simulated, adherence7: s.adherence7,
      },
      cohort: user.cohort,
      status: 'queued',
      trace_id: traceId,
    }));
  }

  return { signals: s, nudges: listNudges(user.id), ids, traceId, degraded, degradedNote };
}

export function listNudges(userId) {
  return all('SELECT * FROM nudges WHERE user_id = ? ORDER BY id DESC', userId)
    .map((n) => ({ ...n, rationale: json(n.rationale_json, {}) }));
}

export function markNudge(id, status) {
  const row = get('SELECT * FROM nudges WHERE id = ?', id);
  if (!row) throw new Error('no such nudge');
  run('UPDATE nudges SET status = ? WHERE id = ?', status, id);
  insert('events', {
    user_id: row.user_id,
    type: status === 'escalated' ? 'rm_callback_requested' : `nudge_${status}`,
    payload_json: { id },
  });
  return { ...get('SELECT * FROM nudges WHERE id = ?', id), rationale: json(row.rationale_json, {}) };
}
