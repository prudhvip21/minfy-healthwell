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
  dayEntries, validateSwap, gate, applySwap, addDays, today, AUTO_APPLY_THRESHOLD,
} from '../engine.js';

const SWAP_SCHEMA = jsonSchema('plan_adjustment', {
  type: 'object',
  additionalProperties: false,
  required: ['rationale', 'user_message', 'confidence', 'remove_entry_ids', 'add_items'],
  properties: {
    rationale: { type: 'string', description: 'For the dietitian: why this adjustment. ≤ 25 words.' },
    user_message: { type: 'string', description: 'For the user: one warm sentence, ≤ 18 words. No blame.' },
    confidence: { type: 'number', description: '0-1. How sure are you this is the right adjustment?' },
    remove_entry_ids: {
      type: 'array',
      items: { type: 'integer' },
      description: 'plan_entry ids to drop, chosen from the candidates given',
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

const SYSTEM = `You adjust an Indian diet plan after a user has eaten something off-plan.

You do not decide anything. You propose, and a deterministic rules engine then
checks your proposal against the user's calorie budget, allergies and diet. If
the engine objects, a human dietitian reviews it. Propose accordingly:

- Prefer the smallest change that works. Removing one item usually beats
  rebuilding the day.
- Compensate within the SAME day where possible, and only in later meals — never
  retroactively change a meal the user has already eaten.
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
export async function proposeAdjustment({ user, date = today(), unplanned = [], trigger = 'checkin' }) {
  const entries = dayEntries(user.id, date);
  const remaining = entries.filter((e) => e.status === 'planned');

  const offPlanText = unplanned.length
    ? unplanned.map((u) => `- ${u.name} (${u.qty ?? 1} ${u.unit || 'serving'}, ~${u.kcal ?? '?'} kcal est.)`).join('\n')
    : '- (none supplied)';

  const candidatesText = remaining.length
    ? remaining.map((e) => `- id ${e.id}: ${e.name} — ${e.qty ?? 1} ${e.unit || ''} (${e.slot}, ~${e.kcal} kcal est.)`).join('\n')
    : '- (nothing left in the day)';

  const input = `User: ${user.name}, ${user.age}, ${user.sex}. Goal: ${user.goal}.
Conditions: ${json(user.conditions_json, []).join(', ') || 'none recorded'}.
Diet: ${user.diet}. Allergies: ${json(user.allergies_json, []).join(', ') || 'none recorded'}.

Date: ${date}. Trigger: ${trigger}.

Eaten off-plan:
${offPlanText}

Remaining planned items today that you may remove (use these ids exactly):
${candidatesText}

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
    proposal_json: { ...proposal, rationale: data.rationale, user_message: data.user_message, trigger },
    engine_json: {
      delta: validation.delta,
      kcalDriftPct: validation.kcalDriftPct,
      reasons: validation.reasons,
      conflicts: validation.conflicts,
      removals: validation.removals.map((r) => ({ id: r.id, name: r.name, kcal: r.kcal })),
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
    userMessage: data.user_message,
    validation,
    guardrails: verdictRecord(null, gateOut),
    traceId, degraded, degradedNote,
  };
}

function summarise(validation, data) {
  const rm = validation.removals.map((r) => r.name);
  const ad = validation.additions.map((a) => a.name);
  if (rm.length && ad.length) return `Swap ${rm.join(', ')} → ${ad.join(', ')}`;
  if (rm.length) return `Drop ${rm.join(', ')}`;
  if (ad.length) return `Add ${ad.join(', ')}`;
  return data.rationale?.slice(0, 80) || 'No change proposed';
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
