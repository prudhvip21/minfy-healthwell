/**
 * DOCX diet plan → canonical structured plan.
 *
 * Dietitian plans are written for humans: the tables are transposed (rows are
 * meal slots, columns are days), quantities are glued to food names
 * ("Idli-3no"), alternatives are expressed in prose ("Curd-1/2cup or
 * Buttermilk-1glass"), one cell can hold three items at three different times,
 * and the food names are regional. No macros appear anywhere.
 *
 * That is precisely the "unstructured input becomes a database row" job the
 * advisory note assigns to the LLM — so the model does the structure, and the
 * engine owns every number it produces.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import mammoth from 'mammoth';

import { all, get, insert, run, json, PLANS_DIR, DATA_DIR } from './db.js';
import { callModel, jsonSchema, hasKey } from './openai.js';
import {
  normaliseSlot, materialisePlan, profileConflicts, normaliseName,
  addDays, today, estimateMacros,
} from './engine.js';
import { ensureUsers, seedHistory, seedCohortStats, seedPartners, HISTORY_DAYS } from './seed.js';

const MAP_PATH = path.join(DATA_DIR, 'plan-map.json');

/** Items the model was less sure about than this go to a dietitian. */
const PARSE_REVIEW_THRESHOLD = 0.75;

/* ------------------------------------------------------------------ *
 * Extraction schema
 * ------------------------------------------------------------------ */

const PLAN_SCHEMA = jsonSchema('diet_plan', {
  type: 'object',
  additionalProperties: false,
  required: ['plan_title', 'cycle_days', 'days', 'guidance', 'targets_stated', 'parse_notes'],
  properties: {
    plan_title: { type: 'string' },
    cycle_days: { type: 'integer', description: 'How many distinct days the plan authors' },
    targets_stated: {
      type: 'object',
      additionalProperties: false,
      required: ['present', 'kcal', 'protein_g', 'carbs_g', 'fat_g'],
      description: 'Only fill these if the document literally states targets. Otherwise present=false and nulls.',
      properties: {
        present: { type: 'boolean' },
        kcal: { type: ['number', 'null'] },
        protein_g: { type: ['number', 'null'] },
        carbs_g: { type: ['number', 'null'] },
        fat_g: { type: ['number', 'null'] },
      },
    },
    days: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['day_index', 'label', 'meals'],
        properties: {
          day_index: { type: 'integer' },
          label: { type: 'string' },
          meals: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['slot', 'time_hint', 'items'],
              properties: {
                slot: { type: 'string' },
                time_hint: { type: ['string', 'null'] },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['name', 'qty', 'unit', 'alternatives', 'notes', 'confidence', 'source_text'],
                    properties: {
                      name: { type: 'string', description: 'Food name only, no quantity' },
                      qty: { type: ['number', 'null'] },
                      unit: { type: ['string', 'null'], description: 'no, cup, tsp, tbsp, glass, handful, g, ml' },
                      alternatives: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Other foods the user may have instead of this one, when the cell says "or"',
                      },
                      notes: { type: ['string', 'null'], description: 'Preparation asides, e.g. "add 1tsp ghee"' },
                      confidence: { type: 'number', description: '0-1, how certain the extraction is' },
                      source_text: { type: 'string', description: 'The exact fragment this came from' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    guidance: { type: 'array', items: { type: 'string' }, description: 'General instructions outside the meal grid' },
    parse_notes: { type: 'string', description: 'Anything ambiguous or unreadable' },
  },
});

const SYSTEM = `You convert Indian dietitian meal-plan documents into structured data.

These documents are laid out for a human reader. Expect all of the following:

- TRANSPOSED TABLES. The first column is the meal slot ("Wake up Meal", "Breakfast",
  "Mid-Morning", "Lunch", "Post Exercise", "Dinner", "Post Dinner"), the second column
  is the time, and EACH REMAINING COLUMN IS A SEPARATE DAY ("Day-1", "Day-2", ...).
  A document often contains several tables covering different days; merge them into
  one ordered list of days and number them from the column headers, not the table order.
- MULTI-ITEM CELLS. One cell can hold several foods, separated by commas or on
  separate lines. Emit one item per distinct food. A cell with three lines and a
  time column listing three times means one item per time.
- GLUED QUANTITIES. "Idli-3no" is 3 idli. "Coconut Chutney-3tbsp" is 3 tbsp.
  "Curd-1/2cup" is 0.5 cup. "Roasted Peanuts-1Handful" is 1 handful. Separate the
  food name from the number and the unit. Never leave a quantity inside the name.
- ALTERNATIVES. "Curd-1/2cup or Buttermilk with jeera-1glass" is ONE item (curd)
  with one alternative (buttermilk), not two items.
- PARENTHETICAL PREPARATION. "(add 1tsp of ghee)" is a note on the item it follows,
  not a separate food — unless it is clearly its own line.
- REGIONAL NAMES. Thotakura Pappu, Bendakaya Curry, Goru Chikudikaya, Putnallu,
  Raitha, Poha, Rasam, Sambar. Keep the dietitian's name for the food exactly as
  written; do not translate or "correct" it.

Set confidence below 0.75 for anything genuinely ambiguous — a vague item like
"Fruit-1no" with no fruit named, an unreadable fragment, or a quantity you had to
guess. Those go to a human dietitian for review, so be honest rather than generous.

Do NOT invent calories or macros. The engine computes those separately.`;

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

export function listPlanFiles() {
  if (!fs.existsSync(PLANS_DIR)) return [];
  return fs.readdirSync(PLANS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.docx') && !f.startsWith('~$'))
    .sort();
}

/**
 * Which document belongs to which user. Written to data/plan-map.json on first
 * run so it can be edited by hand; files are shared round-robin when there are
 * fewer documents than users.
 */
export function planAssignment(users, files) {
  let map = {};
  try { map = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')); } catch { /* first run */ }

  let changed = false;
  users.forEach((u, i) => {
    if (map[u.id] && files.includes(map[u.id])) return;
    map[u.id] = files.length ? files[i % files.length] : null;
    changed = true;
  });

  if (changed) {
    try { fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2)); } catch { /* non-fatal */ }
  }
  return map;
}

async function parseDocument(file, userId) {
  const abs = path.join(PLANS_DIR, file);
  const buffer = fs.readFileSync(abs);
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);

  const { value: html } = await mammoth.convertToHtml({ buffer });

  const { data, traceId, degraded, degradedNote } = await callModel({
    route: 'plan.parse',
    userId,
    system: SYSTEM,
    input: `Convert this meal plan document into structured data.\n\nFile: ${file}\n\n${html}`,
    format: PLAN_SCHEMA,
    // One call per document and everything downstream depends on it — but the
    // work is careful transcription, not deep reasoning, so medium effort with a
    // generous budget beats high effort racing a token cap.
    effort: 'medium',
    maxOutput: 48000,
    timeoutMs: 300_000,
  });

  return { parsed: data, hash, html, traceId, degraded, degradedNote };
}

/** Write a parsed plan to the database and materialise it onto dates. */
function storePlan(user, file, hash, parsed, parseStatus, note) {
  clearUserPlan(user.id);

  const stated = parsed.targets_stated || {};
  const planId = insert('plans', {
    user_id: user.id,
    source_file: file,
    file_hash: hash,
    start_date: user.start_date,
    duration_days: parsed.cycle_days || (parsed.days || []).length || 7,
    targets_json: stated.present
      ? { kcal: stated.kcal, protein_g: stated.protein_g, carbs_g: stated.carbs_g, fat_g: stated.fat_g, source: 'document' }
      : { source: 'estimated' },
    guidance_json: parsed.guidance || [],
    parse_status: parseStatus,
    parse_note: note || parsed.parse_notes || null,
  });

  const lowConfidence = [];
  const allItems = [];

  for (const day of parsed.days || []) {
    const dayId = insert('plan_days', {
      plan_id: planId,
      day_index: day.day_index,
      label: day.label || `Day ${day.day_index}`,
    });

    for (const meal of day.meals || []) {
      const slot = normaliseSlot(meal.slot);
      for (const item of meal.items || []) {
        const qty = item.qty ?? 1;
        const macros = estimateMacros(item.name, qty, item.unit);
        const notes = [item.notes, item.alternatives?.length ? `or ${item.alternatives.join(' / ')}` : null]
          .filter(Boolean).join(' · ') || null;

        const itemId = insert('plan_items', {
          plan_day_id: dayId, slot, time_hint: meal.time_hint,
          name: item.name, qty, unit: item.unit,
          kcal: macros.kcal, protein_g: macros.protein_g, carbs_g: macros.carbs_g, fat_g: macros.fat_g,
          notes, confidence: item.confidence ?? 1, source_text: item.source_text,
          macro_source: 'estimated',
        });

        allItems.push({ id: itemId, name: item.name, notes, day: day.day_index, slot });
        if ((item.confidence ?? 1) < PARSE_REVIEW_THRESHOLD) {
          lowConfidence.push({ id: itemId, name: item.name, day: day.day_index, slot, confidence: item.confidence, source_text: item.source_text });
        }
      }
    }
  }

  // Expand the authored cycle across the history window and four weeks forward.
  const start = user.start_date || addDays(today(), -(HISTORY_DAYS - 1));
  materialisePlan(user.id, planId, start, HISTORY_DAYS + 14, { force: true });

  return { planId, lowConfidence, allItems };
}

/**
 * Raise dietitian review items. Two sources, one queue: extraction the model
 * was unsure about, and plan contents that collide with the user's profile.
 */
function raiseReviews(user, planId, lowConfidence, allItems, file, { includeParse = true } = {}) {
  // Extraction doubts belong to the document, not the user — raise them once
  // per document, and once per distinct fragment: "Fruit-1no" on three days is
  // one question for a dietitian, not three.
  const groups = new Map();
  for (const item of includeParse ? lowConfidence : []) {
    const key = String(item.source_text || item.name).replace(/\s+/g, ' ').trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, { ...item, occurrences: [] });
    groups.get(key).occurrences.push({ day: item.day, slot: item.slot, plan_item_id: item.id });
  }
  for (const g of groups.values()) {
    const days = g.occurrences.map((o) => o.day);
    insert('plan_changes', {
      user_id: user.id, kind: 'parse_review',
      summary: `Unclear plan item: "${g.name}" (${g.slot}, Day ${days.join(', ')})`,
      proposal_json: { ...g, source_file: file },
      confidence: g.confidence,
      status: 'pending',
      reason: `Extraction confidence ${(g.confidence * 100).toFixed(0)}% from the source text "${g.source_text}"${g.occurrences.length > 1 ? `, which appears ${g.occurrences.length}× in the document` : ''}. A dietitian should confirm the food and quantity.`,
    });
  }
  const parseCount = groups.size;

  // Profile conflicts, grouped by the ingredient that triggered them. The
  // document repeats foods daily and puts ghee in half the notes; a dietitian
  // needs one row per ingredient decision, not forty.
  const groupsByTerm = new Map();
  for (const item of allItems) {
    for (const c of profileConflicts(user, [item])) {
      const key = `${c.kind}:${c.allergen}:${c.matched}`;
      if (!groupsByTerm.has(key)) groupsByTerm.set(key, { conflict: c, items: new Set(), occurrences: [] });
      const g = groupsByTerm.get(key);
      g.items.add(item.name);
      g.occurrences.push({ day: item.day, slot: item.slot, item: item.name });
    }
  }

  for (const g of groupsByTerm.values()) {
    const c = g.conflict;
    const items = [...g.items];
    const against = c.kind === 'allergy' ? `${c.allergen} allergy` : `${user.diet} diet`;
    insert('plan_changes', {
      user_id: user.id,
      kind: 'parse_review',
      summary: `${c.severity === 'high' ? 'Conflict' : 'Check'}: ${c.matched} vs. ${against}${items.length > 1 ? ` (${items.length} items)` : ` — "${items[0]}"`}`,
      proposal_json: { conflict: c, items, occurrences: g.occurrences, source_file: file },
      confidence: null,
      status: 'pending',
      reason: `${c.reason} Affects ${items.join(', ')} — ${g.occurrences.length}× across the plan. ${c.severity === 'high' ? 'The engine blocked auto-approval; a dietitian decides the substitution.' : 'Not blocking; flagged for a dietitian to confirm.'}`,
    });
  }

  return groupsByTerm.size + parseCount;
}

/**
 * Replacing a plan invalidates everything derived from its dated entries —
 * check-ins point at entry ids that are about to disappear. Clear the user's
 * derived state so seedHistory rebuilds it against the new plan. Traces are
 * kept: they are a log of what happened, not state.
 */
function clearUserPlan(userId) {
  for (const t of ['checkin_items', 'checkins', 'plan_changes', 'nudges', 'events', 'plan_entries']) {
    run(`DELETE FROM ${t} WHERE user_id = ?`, userId);
  }
  run('DELETE FROM plans WHERE user_id = ?', userId);   // cascades to plan_days and plan_items
}

/** Minimal plan used only when the assigned document cannot be parsed. */
function seedFallbackPlan(user, { file = null, reason = 'No plan document is assigned to this user.' } = {}) {
  clearUserPlan(user.id);
  const planId = insert('plans', {
    user_id: user.id, source_file: file, file_hash: null,
    start_date: user.start_date, duration_days: 1,
    targets_json: { source: 'estimated' },
    guidance_json: ['Fallback plan — the source document has not been parsed.'],
    parse_status: 'failed',
    parse_note: reason,
  });
  const dayId = insert('plan_days', { plan_id: planId, day_index: 1, label: 'Fallback day' });
  const items = [
    ['Breakfast', '8:00 AM', 'Idli', 3, 'no'],
    ['Lunch', '1:00 PM', 'Rice', 1, 'cup'],
    ['Lunch', '1:00 PM', 'Dal', 1, 'cup'],
    ['Snack', '5:00 PM', 'Tea', 1, 'cup'],
    ['Dinner', '8:00 PM', 'Roti', 2, 'no'],
    ['Dinner', '8:00 PM', 'Mixed Vegetable Curry', 1, 'cup'],
  ];
  for (const [slot, time, name, qty, unit] of items) {
    const m = estimateMacros(name, qty, unit);
    insert('plan_items', {
      plan_day_id: dayId, slot, time_hint: time, name, qty, unit,
      kcal: m.kcal, protein_g: m.protein_g, carbs_g: m.carbs_g, fat_g: m.fat_g,
      confidence: 1, source_text: 'seeded fallback', macro_source: 'estimated',
    });
  }
  materialisePlan(user.id, planId, user.start_date, HISTORY_DAYS + 14, { force: true });
  return planId;
}

/**
 * Full bootstrap: users, plans, history, reference data.
 * Safe to call repeatedly — unchanged documents are not re-parsed.
 */
export async function importPlans({ force = false, log = console.log } = {}) {
  const users = ensureUsers();
  seedCohortStats();
  seedPartners();

  const files = listPlanFiles();
  const map = planAssignment(users, files);
  const report = [];
  // Users sharing a document share one parse — one model call per file, not per user —
  // and one set of extraction questions for the dietitian.
  const parsedByHash = new Map();
  const parseReviewed = new Set();

  if (!files.length) {
    log('No .docx files in plans/ — every user falls back to a seeded plan.');
  } else if (files.length < users.length) {
    log(`${files.length} plan document(s) for ${users.length} users — documents are shared; drop more .docx files in plans/ and re-run.`);
  }

  for (const user of users) {
    const file = map[user.id];
    const existing = get('SELECT * FROM plans WHERE user_id = ? ORDER BY id DESC LIMIT 1', user.id);

    if (!file) {
      if (!existing) seedFallbackPlan(user);
      report.push({ user: user.id, file: null, status: 'fallback', items: 0, reviews: 0 });
      continue;
    }

    const buffer = fs.readFileSync(path.join(PLANS_DIR, file));
    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);

    if (!force && existing && existing.file_hash === hash && existing.parse_status === 'parsed') {
      const { items, reviews } = rehydrate(user, existing, file, { includeParse: !parseReviewed.has(hash) });
      parseReviewed.add(hash);
      report.push({ user: user.id, file, status: 'cached', items, reviews });
      log(`${user.name}: ${file} unchanged — reusing the stored parse (${items} items).`);
      continue;
    }

    if (!hasKey()) {
      if (!existing) seedFallbackPlan(user, { file, reason: 'Waiting for OPENAI_API_KEY — the document will be parsed on the next start once the key is in .env.' });
      report.push({ user: user.id, file, status: 'no-key', items: 0, reviews: 0 });
      log(`${user.name}: OPENAI_API_KEY not set — using a fallback plan.`);
      continue;
    }

    try {
      let parse = parsedByHash.get(hash);
      if (parse) {
        log(`${user.name}: ${file} already parsed this run — reusing it.`);
      } else {
        log(`${user.name}: parsing ${file} (one model call — can take a minute or two) …`);
        parse = await parseDocument(file, user.id);
        parsedByHash.set(hash, parse);
      }
      const { parsed, traceId, degraded, degradedNote } = parse;
      const { planId, lowConfidence, allItems } = storePlan(
        user, file, hash, parsed,
        degraded ? 'parsed' : 'parsed',
        degraded ? degradedNote : null,
      );
      const reviews = raiseReviews(user, planId, lowConfidence, allItems, file, { includeParse: !parseReviewed.has(hash) });
      parseReviewed.add(hash);

      report.push({
        user: user.id, file, status: degraded ? 'degraded' : 'parsed',
        days: (parsed.days || []).length, items: allItems.length, reviews, traceId,
      });
      log(`  → ${(parsed.days || []).length} days, ${allItems.length} items, ${reviews} for dietitian review${degraded ? ' (degraded — served from cache)' : ''}`);
    } catch (err) {
      log(`  ! parse failed: ${err.message}`);
      if (!existing || existing.parse_status !== 'parsed') {
        seedFallbackPlan(user, { file, reason: `Parse failed: ${String(err.message).slice(0, 200)}` });
      }
      report.push({ user: user.id, file, status: 'failed', error: err.message, items: 0, reviews: 0 });
    }
  }

  // Safety net: any user whose plan survived a reset but whose dated entries
  // did not (fallback plans take a different path above) gets re-expanded.
  for (const user of users) {
    if (get('SELECT COUNT(*) AS n FROM plan_entries WHERE user_id = ?', user.id).n > 0) continue;
    const plan = get('SELECT * FROM plans WHERE user_id = ? ORDER BY id DESC LIMIT 1', user.id);
    if (plan) materialisePlan(user.id, plan.id, user.start_date, HISTORY_DAYS + 14, { force: true });
  }

  // History last: it needs materialised plan entries to tick off.
  for (const user of users) seedHistory(user);

  return report;
}

/**
 * Rebuild everything derived from an already-parsed plan. A demo reset keeps
 * the stored parse (a GPT-5 call per document) but clears the dated entries
 * and the review queue, so both are regenerated from what is already stored.
 */
function rehydrate(user, plan, file, { includeParse = true } = {}) {
  const rows = all(
    `SELECT pi.*, pd.day_index FROM plan_items pi
       JOIN plan_days pd ON pd.id = pi.plan_day_id
      WHERE pd.plan_id = ? ORDER BY pd.day_index, pi.id`,
    plan.id,
  );

  // Estimates are the engine's, not the parse's — recompute them from the
  // current food table so improving the table never needs a model call.
  for (const r of rows) {
    if (r.macro_source !== 'estimated') continue;
    const e = estimateMacros(r.name, r.qty, r.unit);
    run(
      'UPDATE plan_items SET kcal = ?, protein_g = ?, carbs_g = ?, fat_g = ? WHERE id = ?',
      e.kcal, e.protein_g, e.carbs_g, e.fat_g, r.id,
    );
  }

  const allItems = rows.map((r) => ({ id: r.id, name: r.name, notes: r.notes, day: r.day_index, slot: r.slot }));
  const lowConfidence = rows
    .filter((r) => (r.confidence ?? 1) < PARSE_REVIEW_THRESHOLD)
    .map((r) => ({
      id: r.id, name: r.name, day: r.day_index, slot: r.slot,
      confidence: r.confidence, source_text: r.source_text,
    }));

  if (get('SELECT COUNT(*) AS n FROM plan_entries WHERE user_id = ?', user.id).n === 0) {
    materialisePlan(user.id, plan.id, user.start_date, HISTORY_DAYS + 14, { force: true });
  }

  const hasReviews = get(
    "SELECT COUNT(*) AS n FROM plan_changes WHERE user_id = ? AND kind = 'parse_review'",
    user.id,
  ).n;
  const reviews = hasReviews ? hasReviews : raiseReviews(user, plan.id, lowConfidence, allItems, file, { includeParse });

  return { items: rows.length, reviews };
}

export function needsBootstrap() {
  return get('SELECT COUNT(*) AS n FROM plan_entries').n === 0;
}

// Standalone: npm run import
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const force = process.argv.includes('--force');
  importPlans({ force })
    .then((r) => {
      console.log('\nImport summary:');
      console.table(r);
      process.exit(0);
    })
    .catch((e) => { console.error(e); process.exit(1); });
}
