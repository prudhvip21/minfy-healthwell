/**
 * Plan-change and readjustment loop.
 *
 * The agent may only ever produce a *proposal*. engine.validateSwap scores it,
 * engine.gate decides its fate, and engine.applySwap is the single write path.
 * A proposal the engine dislikes goes to a dietitian no matter how confident
 * the model was.
 */

import { all, get, insert, run, json } from '../db.js';
import { callModel, jsonSchema } from '../openai.js';
import { scanItems, verdictRecord } from '../guardrails.js';
import {
  dayEntries, dayTotals, validateSwap, gate, applySwap, addDays, today, AUTO_APPLY_THRESHOLD,
} from '../engine.js';

const SWAP_SCHEMA = jsonSchema('plan_adjustment', {
  type: 'object',
  additionalProperties: false,
  required: ['rationale', 'dietitian_summary', 'user_message', 'confidence', 'remove_entry_ids', 'move_items', 'add_items'],
  properties: {
    rationale: { type: 'string', description: 'For the dietitian: why this adjustment. ≤ 25 words.' },
    dietitian_summary: { type: 'string', description: 'Handover note for the dietitian: what the user ate, what went off-plan, and what you changed. ≤ 45 words.' },
    user_message: { type: 'string', description: 'For the user: one warm sentence, ≤ 18 words. No blame.' },
    confidence: { type: 'number', description: '0-1. How sure are you this is the right adjustment?' },
    remove_entry_ids: {
      type: 'array',
      items: { type: 'integer' },
      description: 'plan_entry ids to drop entirely, chosen from the candidates given',
    },
    move_items: {
      type: 'array',
      description: 'Untouched dishes worth keeping — moved to a later day instead of dropped',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['entry_id', 'to_date', 'why'],
        properties: {
          entry_id: { type: 'integer' },
          to_date: { type: 'string', description: 'YYYY-MM-DD, a future day from the list given' },
          why: { type: 'string', description: '≤ 12 words' },
        },
      },
    },
    add_items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'qty', 'unit', 'slot', 'why'],
        properties: {
          name: { type: 'string' },
          qty: { type: ['number', 'null'] },
          unit: { type: ['string', 'null'] },
          slot: { type: 'string' },
          why: { type: 'string', description: '≤ 12 words' },
        },
      },
    },
  },
});

const SYSTEM = `You rebalance an Indian diet plan after a user has eaten something off-plan.

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
  failure.`;

/**
 * Build a proposal for off-plan eating. Writes a plan_changes row and either
 * applies it (engine permitting) or queues it for a dietitian.
 */
export async function proposeAdjustment({ user, date = today(), unplanned = null, trigger = 'checkin' }) {
  const entries = dayEntries(user.id, date);
  const remaining = entries.filter((e) => e.status === 'planned' || e.status === 'added');
  const eaten = entries.filter((e) => e.status === 'eaten');

  // When no off-plan list is supplied, read it off the day itself — that is
  // what "readjust my plan" means: look at what actually happened today.
  const offPlan = unplanned && unplanned.length
    ? unplanned
    : entries.filter((e) => e.status === 'offplan').map((e) => ({
      name: e.name, qty: e.qty, unit: e.unit, kcal: e.kcal, flag: e.flag,
    }));

  const totals = dayTotals(user.id, date);
  const line = (e) => `- id ${e.id}: ${e.name} — ${e.qty ?? 1} ${e.unit || ''} (${e.slot}, ~${Math.round(e.kcal)} kcal est.)`;

  // The next few days, so a move can be judged a genuine replacement.
  const upcoming = [1, 2, 3].map((n) => {
    const d = addDays(date, n);
    const items = dayEntries(user.id, d).filter((e) => e.status === 'planned');
    return `${d}: ${items.map((e) => `${e.slot} — ${e.name}`).join('; ') || '(nothing planned)'}`;
  }).join('\n');

  const input = `User: ${user.name}, ${user.age}, ${user.sex}. Goal: ${user.goal}.
Conditions: ${json(user.conditions_json, []).join(', ') || 'none recorded'}.
Diet: ${user.diet}. Allergies: ${json(user.allergies_json, []).join(', ') || 'none recorded'}.

Date: ${date}. Trigger: ${trigger}.
Day so far: ${totals.consumed.kcal} kcal eaten of ~${totals.planned.kcal} planned${totals.offPlanKcal ? `, of which ${totals.offPlanKcal} kcal was off-plan` : ''}.

Already eaten today (never touch these):
${eaten.map((e) => `- ${e.name} (${e.slot})`).join('\n') || '- nothing yet'}

Eaten off-plan:
${offPlan.length ? offPlan.map((u) => `- ${u.name} (${u.qty ?? 1} ${u.unit || 'serving'}, ~${u.kcal ?? '?'} kcal est.)${u.flag ? ` [${u.flag}]` : ''}`).join('\n') : '- nothing off-plan'}

Still to come today — you may remove these, or move them to a later day (use these ids exactly):
${remaining.length ? remaining.map(line).join('\n') : '- (nothing left in the day)'}

Planned for the next few days, for judging whether a move is a direct replacement:
${upcoming}

Propose the adjustment.`;

  const { data, traceId, degraded, degradedNote } = await callModel({
    route: 'planswap.propose',
    userId: user.id,
    system: SYSTEM,
    input,
    format: SWAP_SCHEMA,
    // The engine re-checks every number, so the agent needs judgment, not depth.
    // Reasoning tokens count against the cap on GPT-5 — leave real headroom.
    effort: 'low',
    maxOutput: 12000,
  });

  // ---- engine takes over ----

  const proposal = {
    date,
    removals: data.remove_entry_ids || [],
    moves: (data.move_items || []).map((m) => ({ entry_id: m.entry_id, to_date: m.to_date, why: m.why })),
    additions: (data.add_items || []).map((a) => ({
      name: a.name, qty: a.qty ?? 1, unit: a.unit, slot: a.slot, notes: a.why,
    })),
  };

  const validation = validateSwap(user, proposal);
  const gateOut = scanItems(user, validation.additions);
  const decision = gate({ validation, confidence: data.confidence ?? 0 });

  const changeId = insert('plan_changes', {
    user_id: user.id,
    kind: 'swap',
    summary: summarise(validation, data),
    proposal_json: {
      ...proposal,
      rationale: data.rationale,
      dietitian_summary: data.dietitian_summary,
      user_message: data.user_message,
      trigger,
    },
    engine_json: {
      delta: validation.delta,
      kcalDriftPct: validation.kcalDriftPct,
      reasons: validation.reasons,
      conflicts: validation.conflicts,
      removals: validation.removals.map((r) => ({ id: r.id, name: r.name, kcal: r.kcal })),
      moves: validation.moves.map((m) => ({ id: m.entry.id, name: m.entry.name, slot: m.entry.slot, kcal: m.entry.kcal, to: m.to })),
      additions: validation.additions.map((a) => ({ name: a.name, qty: a.qty, unit: a.unit, slot: a.slot, kcal: a.kcal, macro_source: a.macro_source })),
      threshold: AUTO_APPLY_THRESHOLD,
    },
    confidence: data.confidence ?? null,
    status: decision.decision,
    reason: decision.reason,
    trace_id: traceId,
    decided_at: decision.decision === 'auto_applied' ? new Date().toISOString() : null,
  });

  if (decision.decision === 'auto_applied') {
    applySwap(user, validation);
    insert('events', { user_id: user.id, type: 'plan_auto_adjusted', payload_json: { changeId, delta: validation.delta } });
  } else {
    insert('events', { user_id: user.id, type: `plan_change_${decision.decision}`, payload_json: { changeId } });
  }

  return {
    changeId,
    decision: decision.decision,
    reason: decision.reason,
    confidence: data.confidence,
    rationale: data.rationale,
    dietitianSummary: data.dietitian_summary,
    userMessage: data.user_message,
    validation,
    guardrails: verdictRecord(null, gateOut),
    traceId, degraded, degradedNote,
  };
}

function summarise(validation, data) {
  const parts = [];
  if (validation.removals.length) parts.push(`drop ${validation.removals.map((r) => r.name).join(', ')}`);
  if (validation.moves.length) parts.push(`move ${validation.moves.map((m) => `${m.entry.name} → ${m.to}`).join(', ')}`);
  if (validation.additions.length) parts.push(`add ${validation.additions.map((a) => a.name).join(', ')}`);
  if (!parts.length) return data.rationale?.slice(0, 80) || 'No change proposed';
  const s = parts.join(' · ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Dietitian decision on a queued proposal. The other write path into plans. */
export function decide({ changeId, decision, reviewer = 'Dietitian (demo)' }) {
  const change = get('SELECT * FROM plan_changes WHERE id = ?', changeId);
  if (!change) throw new Error(`no such change ${changeId}`);
  if (change.status !== 'pending') {
    throw new Error(`change ${changeId} is already ${change.status}`);
  }

  const user = get('SELECT * FROM users WHERE id = ?', change.user_id);

  if (decision === 'approved') {
    if (change.kind === 'swap') {
      const proposal = json(change.proposal_json, {});
      // Re-validate at approval time: the day may have moved on since the
      // proposal was made, and the engine's answer is the one that counts.
      const validation = validateSwap(user, proposal);
      if (!validation.valid) {
        run(
          "UPDATE plan_changes SET status = 'rejected', reason = ?, reviewer = ?, decided_at = datetime('now') WHERE id = ?",
          `Re-validated at approval and refused: ${validation.blocking.map((b) => b.reason).join(' ')}`,
          reviewer, changeId,
        );
        return { status: 'rejected', reason: 'Engine refused the change at approval time.', validation };
      }
      applySwap(user, validation);
    }
    run(
      "UPDATE plan_changes SET status = 'approved', reviewer = ?, decided_at = datetime('now') WHERE id = ?",
      reviewer, changeId,
    );
    insert('events', { user_id: user.id, type: 'plan_change_approved', payload_json: { changeId, reviewer } });
    return { status: 'approved' };
  }

  run(
    "UPDATE plan_changes SET status = 'rejected', reviewer = ?, decided_at = datetime('now') WHERE id = ?",
    reviewer, changeId,
  );
  insert('events', { user_id: user.id, type: 'plan_change_rejected', payload_json: { changeId, reviewer } });
  return { status: 'rejected' };
}

export function reviewQueue(userId = null) {
  const rows = userId
    ? all("SELECT * FROM plan_changes WHERE user_id = ? ORDER BY (status='pending') DESC, id DESC", userId)
    : all("SELECT * FROM plan_changes ORDER BY (status='pending') DESC, id DESC");
  return rows.map((r) => ({
    ...r,
    proposal: json(r.proposal_json, {}),
    engine: json(r.engine_json, null),
  }));
}
