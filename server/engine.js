/**
 * The rules engine. Deterministic, no model calls, no network.
 *
 * Everything an agent wants to change to a user's plan passes through here
 * first. Agents produce proposals; this file decides whether a proposal is
 * valid, what it costs in macros, and whether it may be applied without a
 * dietitian. If you want to know what the AI is not allowed to do, read this
 * file — it is the whole answer.
 */

import { all, get, insert, run, json } from './db.js';

/** Canonical meal slots, in the order a day runs. */
export const SLOTS = [
  'Wake up', 'Breakfast', 'Mid-Morning', 'Lunch',
  'Snack', 'Post Exercise', 'Dinner', 'Post Dinner',
];

const SLOT_ALIASES = {
  'wake up meal': 'Wake up', 'wake-up': 'Wake up', 'wakeup': 'Wake up',
  'early morning': 'Wake up', 'on waking': 'Wake up',
  'break fast': 'Breakfast', 'morning': 'Breakfast',
  'mid morning': 'Mid-Morning', 'midmorning': 'Mid-Morning',
  'mid-evening': 'Snack', 'evening snack': 'Snack', 'evening': 'Snack',
  'post workout': 'Post Exercise', 'post-workout': 'Post Exercise',
  'post exercise': 'Post Exercise', 'pre exercise': 'Post Exercise',
  'post dinner': 'Post Dinner', 'bed time': 'Post Dinner', 'bedtime': 'Post Dinner',
};

export function normaliseSlot(raw) {
  if (!raw) return 'Snack';
  const k = String(raw).toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (SLOT_ALIASES[k]) return SLOT_ALIASES[k];
  const hit = SLOTS.find((s) => s.toLowerCase() === k);
  return hit || SLOTS.find((s) => k.includes(s.toLowerCase())) || 'Snack';
}

/* ------------------------------------------------------------------ *
 * Name normalisation and matching
 * ------------------------------------------------------------------ */

const NOISE = /\b(add|of|with|or|and|no|nos|cup|cups|tsp|tbsp|glass|handful|piece|pieces|bowl|small|medium|large|boiled|roasted|stir|fry|fried|raw|fresh)\b/g;

export function normaliseName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')          // drop parenthetical asides
    .replace(/[\d./]+/g, ' ')          // drop quantities
    .replace(/[^a-z\s]/g, ' ')
    .replace(NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Regional and spelling variants that name the same food. */
const SYNONYMS = {
  pappu: 'dal', daal: 'dal', dhal: 'dal', paruppu: 'dal',
  raitha: 'raita', dahi: 'curd', thayir: 'curd', perugu: 'curd',
  chapati: 'roti', chapathi: 'roti', phulka: 'roti', fulka: 'roti',
  chaas: 'buttermilk', majjiga: 'buttermilk', mor: 'buttermilk',
  chai: 'tea', badam: 'almond', kishmish: 'raisin', pista: 'pistachio',
  bendakaya: 'okra', bhindi: 'okra', ladyfinger: 'okra',
  thotakura: 'amaranth', putnallu: 'gram',
};

/** "chapatis" → "chapati", "idlis" → "idli"; leaves "glass"-style words alone. */
const singular = (t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t);

function tokens(s) {
  return new Set(
    normaliseName(s).split(' ').filter((t) => t.length > 2).map(singular).map((t) => SYNONYMS[t] || t),
  );
}

/**
 * Containment-weighted token overlap. Deliberately not a fuzzy string
 * distance: "tomato dal" vs "tomato pappu" should match on the shared
 * head noun, while "brown rice" vs "white rice" should not score high
 * enough to auto-apply.
 */
export function similarity(a, b) {
  const ta = tokens(a); const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  if (!shared) return 0;
  return shared / Math.min(ta.size, tb.size) * (shared / Math.max(ta.size, tb.size)) ** 0.5;
}

export const MATCH_THRESHOLD = 0.5;

/** Best plan entry for a logged item, or null. Never mutates. */
export function findMatch(loggedName, entries) {
  let best = null; let bestScore = 0;
  for (const e of entries) {
    const s = similarity(loggedName, e.name);
    if (s > bestScore) { bestScore = s; best = e; }
  }
  return bestScore >= MATCH_THRESHOLD ? { entry: best, score: bestScore } : null;
}

/* ------------------------------------------------------------------ *
 * Profile conflicts — allergies and diet, checked against any item list.
 * Used at plan import AND at every check-in. This is a hard gate: it does
 * not consult a model and a model cannot overrule it.
 * ------------------------------------------------------------------ */

const ALLERGEN_TERMS = {
  peanut: {
    severity: 'high',
    terms: ['peanut', 'peanuts', 'groundnut', 'ground nut', 'moongphali', 'mungfali', 'palli', 'peanut butter'],
  },
  treenut: {
    severity: 'high',
    terms: ['almond', 'cashew', 'walnut', 'pista', 'pistachio', 'brazilnut', 'brazil nut', 'hazelnut', 'badam'],
  },
  dairy: {
    severity: 'high',
    terms: ['milk', 'curd', 'yoghurt', 'yogurt', 'buttermilk', 'raitha', 'raita', 'paneer', 'cheese', 'lassi', 'khoya', 'cream', 'butter'],
    // Ghee is dairy but effectively lactose-free; flag it, don't alarm over it.
    low: ['ghee'],
  },
  gluten: { severity: 'high', terms: ['wheat', 'roti', 'chapati', 'bread', 'atta', 'maida', 'suji', 'rava', 'poori'] },
  egg: { severity: 'high', terms: ['egg', 'omelette', 'omelet', 'anda'] },
  soy: { severity: 'high', terms: ['soy', 'soya', 'tofu'] },
  shellfish: { severity: 'high', terms: ['prawn', 'shrimp', 'crab', 'lobster'] },
};

/** Diet rules — what a diet forbids. */
const DIET_FORBIDS = {
  vegan: ['dairy', 'egg', 'meat'],
  vegetarian: ['egg', 'meat'],
  'lacto-vegetarian': ['egg', 'meat'],
  'ovo-vegetarian': ['meat'],
  eggetarian: ['meat'],
};

const MEAT_TERMS = ['chicken', 'mutton', 'fish', 'prawn', 'meat', 'non veg', 'nonveg', 'beef', 'pork', 'lamb', 'egg'];

function hasTerm(text, terms) {
  const n = ` ${normaliseName(text)} `;
  return terms.find((t) => n.includes(` ${t} `) || n.includes(` ${t}s `));
}

/**
 * @returns {Array<{item, kind, allergen, severity, matched, reason}>}
 */
export function profileConflicts(user, items) {
  const allergies = json(user.allergies_json, []).map((a) => String(a).toLowerCase());
  const diet = String(user.diet || '').toLowerCase();
  const forbids = DIET_FORBIDS[diet] || [];
  const out = [];

  for (const item of items) {
    const name = item.name || item;
    // Allergens hide in preparation notes ("add 1tsp of ghee", "garnish with
    // peanuts"), so the check reads the name and the notes together.
    const text = [name, item.notes].filter(Boolean).join(' ');

    for (const allergy of allergies) {
      const group = ALLERGEN_TERMS[allergy];
      if (!group) continue;
      const hit = hasTerm(text, group.terms);
      if (hit) {
        out.push({
          item: name, kind: 'allergy', allergen: allergy, severity: group.severity, matched: hit,
          reason: `Contains ${hit} — user profile records a ${allergy} allergy.`,
        });
        continue;
      }
      const lowHit = group.low && hasTerm(text, group.low);
      if (lowHit) {
        out.push({
          item: name, kind: 'allergy', allergen: allergy, severity: 'low', matched: lowHit,
          reason: `Contains ${lowHit}. Derived from ${allergy} but usually tolerated — worth a dietitian's confirmation.`,
        });
      }
    }

    for (const f of forbids) {
      const terms = f === 'meat' ? MEAT_TERMS : (ALLERGEN_TERMS[f]?.terms || []);
      const hit = hasTerm(text, terms);
      if (hit && !out.some((c) => c.item === name && c.matched === hit)) {
        out.push({
          item: name, kind: 'diet', allergen: f, severity: 'high', matched: hit,
          reason: `Contains ${hit}, which the user's ${diet} diet excludes.`,
        });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Macro estimation fallback. The sample dietitian plans carry no macros
 * at all, so every number in this app is an estimate — and is labelled
 * 'estimated' wherever it is shown. Per 1 unit of the stated measure.
 * ------------------------------------------------------------------ */

/*
 * Values are per ONE of the unit the plan uses for that food: per piece for
 * idli, roti, egg and individual nuts; per cup for rice, dal, curry, curd;
 * per tbsp for chutney; per glass for drinks. A `handful` override covers
 * foods measured that way. Order matters — first match wins, so compound
 * names ("Cucumber, Banana, smoothie") must hit the specific entry first.
 */
const m = (kcal, protein_g, carbs_g, fat_g) => ({ kcal, protein_g, carbs_g, fat_g });

const FOOD_TABLE = [
  [/smoothie/, m(150, 2.5, 28, 4)],
  [/chamomile|green tea|warm water|\bwater\b/, m(2, 0, 0, 0)],
  // Common off-plan foods — what people actually report in the plan-change loop.
  [/biryani|pulao|pulav/, m(290, 11, 38, 10), { plate: m(580, 22, 76, 20), serving: m(450, 17, 59, 16), bowl: m(450, 17, 59, 16) }],
  [/samosa/, m(260, 4, 30, 14)],
  [/gulab jamun|jalebi|rasgulla|laddu|barfi|halwa|sweet/, m(150, 2, 24, 6)],
  [/lassi/, m(260, 8, 40, 7)],
  [/coke|cola|pepsi|soft drink|soda|sprite|fanta/, m(100, 0, 26, 0), { can: m(140, 0, 39, 0), bottle: m(210, 0, 55, 0) }],
  [/paratha/, m(260, 6, 36, 10)],
  [/puri|poori|bhatura/, m(100, 1.5, 12, 5)],
  [/vada|bonda|pakora|bajji|bhajji/, m(130, 4, 14, 7)],
  [/pizza/, m(285, 12, 36, 10)],
  [/burger/, m(450, 20, 45, 20)],
  [/chips|namkeen|mixture|bhujia/, m(150, 2, 15, 10)],
  [/ice cream|kulfi/, m(140, 2.5, 17, 7)],
  [/paneer/, m(270, 17, 6, 20)],
  [/buttermilk|chaas/, m(40, 2, 4, 1.5)],
  [/raitha|raita/, m(120, 5, 9, 7)],
  [/curd|yoghurt|yogurt|dahi/, m(150, 8.5, 11, 8)],
  [/idli/, m(58, 1.6, 12, 0.4)],
  [/dosa/, m(133, 2.7, 22, 3.7)],
  [/roti|chapati|phulka/, m(104, 3.1, 20, 1.5)],
  [/rice/, m(205, 4.3, 45, 0.4)],
  [/poha/, m(180, 3.5, 35, 3)],
  [/dal|pappu|sambar/, m(150, 9, 22, 3)],
  [/rasam/, m(60, 2, 9, 2)],
  [/ghee/, m(45, 0, 0, 5)],
  [/\boil\b/, m(40, 0, 0, 4.5)],
  [/chutney/, m(55, 1, 3, 4.5)],
  // Individual nuts and dried fruit — per piece, which is how plans count them.
  [/almond|badam/, m(7, 0.26, 0.25, 0.6), { handful: m(165, 6, 6, 14) }],
  [/cashew/, m(9, 0.3, 0.5, 0.7), { handful: m(160, 5, 9, 13) }],
  [/walnut/, m(13, 0.3, 0.3, 1.3), { handful: m(185, 4.3, 3.9, 18.5) }],
  [/pista|pistachio/, m(4, 0.15, 0.2, 0.3), { handful: m(160, 6, 8, 13) }],
  [/brazil/, m(33, 0.7, 0.6, 3.4)],
  [/raisin|kishmish/, m(2, 0, 0.5, 0), { handful: m(130, 1.4, 34, 0.2) }],
  [/prune/, m(20, 0.2, 5.4, 0)],
  [/date/, m(23, 0.2, 6, 0)],
  [/peanut|groundnut/, m(6, 0.26, 0.2, 0.5), { handful: m(170, 7.5, 5, 14) }],
  [/putnallu|roasted gram|chana/, m(4, 0.2, 0.6, 0.1), { handful: m(110, 6.5, 18, 1.8) }],
  [/sprout/, m(100, 7, 16, 0.6)],
  [/egg/, m(78, 6.3, 0.6, 5.3)],
  [/chicken|mutton|fish|non veg|nonveg|meat/, m(250, 25, 6, 14)],
  [/curry|sabzi|bendakaya|chikudikaya|cabbage|capsicum|vegetable/, m(130, 3, 12, 8)],
  [/salad|cucumber|carrot|beetroot/, m(45, 1.5, 8, 0.5)],
  [/fruit|banana|apple|papaya|pomegranate|orange|guava/, m(90, 1, 22, 0.3)],
  [/tea|coffee/, m(40, 1.2, 5, 1.5)],
];

/** Rough macros for an item when neither the plan nor the model supplied any. */
export function estimateMacros(name, qty = 1, unit = null) {
  const n = normaliseName(name);
  const hit = FOOD_TABLE.find(([re]) => re.test(n));
  const byUnit = hit?.[2] && unit && hit[2][String(unit).toLowerCase().replace(/s$/, '')];
  const base = byUnit || (hit ? hit[1] : m(80, 2, 10, 3));
  const q = Number(qty) > 0 ? Number(qty) : 1;
  return {
    kcal: round(base.kcal * q), protein_g: round(base.protein_g * q),
    carbs_g: round(base.carbs_g * q), fat_g: round(base.fat_g * q),
    macro_source: 'estimated',
  };
}

const round = (n) => Math.round(n * 10) / 10;

/** Fill any missing macro on an item, marking where the numbers came from. */
export function withMacros(item) {
  const missing = ['kcal', 'protein_g', 'carbs_g', 'fat_g'].some(
    (k) => item[k] === null || item[k] === undefined || item[k] === '',
  );
  if (!missing) return { ...item, macro_source: item.macro_source || 'plan' };
  return { ...item, ...estimateMacros(item.name, item.qty, item.unit) };
}

/* ------------------------------------------------------------------ *
 * Materialisation — expand the authored day cycle onto calendar dates.
 * ------------------------------------------------------------------ */

export function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

export function addDays(date, n) {
  const d = new Date(`${isoDate(date)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

export function today() {
  return isoDate(new Date());
}

/**
 * Writes plan_entries for `days` calendar days starting at `startDate`,
 * cycling through the plan's authored days. Idempotent per date: existing
 * entries for a date are left alone unless `force`.
 */
export function materialisePlan(userId, planId, startDate, days = 28, { force = false } = {}) {
  const plan = get('SELECT * FROM plans WHERE id = ?', planId);
  if (!plan) throw new Error(`no plan ${planId}`);

  const cycle = all('SELECT * FROM plan_days WHERE plan_id = ? ORDER BY day_index', planId);
  if (!cycle.length) return 0;

  const itemsByDay = new Map();
  for (const d of cycle) {
    itemsByDay.set(d.id, all('SELECT * FROM plan_items WHERE plan_day_id = ? ORDER BY id', d.id));
  }

  let written = 0;
  for (let i = 0; i < days; i += 1) {
    const date = addDays(startDate, i);
    const existing = get('SELECT COUNT(*) AS n FROM plan_entries WHERE user_id = ? AND date = ?', userId, date);
    if (existing.n > 0) {
      if (!force) continue;
      run('DELETE FROM plan_entries WHERE user_id = ? AND date = ?', userId, date);
    }
    const day = cycle[i % cycle.length];
    for (const item of itemsByDay.get(day.id)) {
      const m = withMacros(item);
      insert('plan_entries', {
        user_id: userId, date, slot: item.slot, time_hint: item.time_hint,
        plan_item_id: item.id, name: item.name, qty: item.qty, unit: item.unit,
        kcal: m.kcal, protein_g: m.protein_g, carbs_g: m.carbs_g, fat_g: m.fat_g,
        macro_source: m.macro_source, status: 'planned',
      });
      written += 1;
    }
  }
  return written;
}

/* ------------------------------------------------------------------ *
 * Daily rollups
 * ------------------------------------------------------------------ */

export function dayEntries(userId, date) {
  return all(
    'SELECT * FROM plan_entries WHERE user_id = ? AND date = ? ORDER BY id',
    userId, date,
  ).sort((a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot));
}

/**
 * Entry statuses:
 *   planned  on the plan, not yet eaten
 *   eaten    on the plan, ticked off by a check-in
 *   added    put on the plan by an approved swap
 *   swapped  taken off the plan by an approved swap
 *   offplan  eaten, but never on the plan — a fact the user reported
 */
const ON_PLAN = new Set(['planned', 'eaten', 'added', 'missed']);
const CONSUMED = new Set(['eaten', 'offplan']);

export function dayTotals(userId, date) {
  const entries = dayEntries(userId, date);
  const sum = (rows, k) => round(rows.reduce((t, r) => t + (r[k] || 0), 0));
  const plan = entries.filter((e) => ON_PLAN.has(e.status));
  const eaten = entries.filter((e) => CONSUMED.has(e.status));
  const off = entries.filter((e) => e.status === 'offplan');
  return {
    planned: {
      kcal: sum(plan, 'kcal'), protein_g: sum(plan, 'protein_g'),
      carbs_g: sum(plan, 'carbs_g'), fat_g: sum(plan, 'fat_g'),
    },
    consumed: {
      kcal: sum(eaten, 'kcal'), protein_g: sum(eaten, 'protein_g'),
      carbs_g: sum(eaten, 'carbs_g'), fat_g: sum(eaten, 'fat_g'),
    },
    offPlanKcal: sum(off, 'kcal'),
    items: plan.length,
    eaten: eaten.length,
    estimated: entries.some((e) => e.macro_source === 'estimated'),
  };
}

/** Share of planned items ticked off, for one date. Off-plan food doesn't count either way. */
export function dayAdherence(userId, date) {
  const entries = dayEntries(userId, date).filter((e) => ON_PLAN.has(e.status));
  if (!entries.length) return null;
  const done = entries.filter((e) => e.status === 'eaten').length;
  return done / entries.length;
}

export function adherenceWindow(userId, endDate, days = 7) {
  const scores = [];
  for (let i = 0; i < days; i += 1) {
    const a = dayAdherence(userId, addDays(endDate, -i));
    if (a !== null) scores.push(a);
  }
  if (!scores.length) return 0;
  return scores.reduce((t, s) => t + s, 0) / scores.length;
}

/** Consecutive days ending today with at least one check-in. */
export function streak(userId, endDate = today()) {
  let n = 0;
  for (let i = 0; i < 400; i += 1) {
    const date = addDays(endDate, -i);
    const row = get('SELECT COUNT(*) AS n FROM checkins WHERE user_id = ? AND date = ?', userId, date);
    if (row.n > 0) n += 1;
    else if (i > 0) break;          // today not yet logged doesn't break a streak
    else if (n === 0 && i === 0) continue;
  }
  return n;
}

export function daysSinceLastCheckin(userId, endDate = today()) {
  const row = get('SELECT MAX(date) AS d FROM checkins WHERE user_id = ?', userId);
  if (!row || !row.d) return null;
  const diff = (new Date(`${endDate}T00:00:00Z`) - new Date(`${row.d}T00:00:00Z`)) / 86400000;
  return Math.round(diff);
}

/* ------------------------------------------------------------------ *
 * Applying change — the only write path into plan_entries.
 * ------------------------------------------------------------------ */

export const AUTO_APPLY_THRESHOLD = 0.85;

/**
 * Validate a swap proposal without applying it. Returns the macro delta and
 * every reason the engine would refuse or escalate. Pure: no writes.
 *
 * proposal = { date, removals: [entryId], additions: [{name, qty, unit, slot, ...}] }
 */
export function validateSwap(user, proposal) {
  const date = proposal.date || today();
  const entries = dayEntries(user.id, date);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const movable = (e) => e && (e.status === 'planned' || e.status === 'added');

  // Moves push an untouched dish to a later day instead of wasting it.
  const horizon = addDays(today(), 14);
  const moves = [];
  for (const mv of proposal.moves || []) {
    const entry = byId.get(Number(mv.entry_id ?? mv.entryId));
    const to = mv.to_date || mv.toDate;
    if (!movable(entry) || !to) continue;
    if (to <= date || to > horizon) continue;          // forward only, inside the plan horizon
    moves.push({ entry, to });
  }

  const removals = (proposal.removals || []).map((id) => byId.get(Number(id))).filter(movable);
  const additions = (proposal.additions || []).map((a) => withMacros({
    ...a, slot: normaliseSlot(a.slot), qty: a.qty ?? 1,
  }));

  const conflicts = profileConflicts(user, additions);
  const blocking = conflicts.filter((c) => c.severity === 'high');

  // A moved item leaves today just as a removed one does.
  const gone = [...removals, ...moves.map((m) => m.entry)];
  const delta = {
    kcal: round(sumOf(additions, 'kcal') - sumOf(gone, 'kcal')),
    protein_g: round(sumOf(additions, 'protein_g') - sumOf(gone, 'protein_g')),
    carbs_g: round(sumOf(additions, 'carbs_g') - sumOf(gone, 'carbs_g')),
    fat_g: round(sumOf(additions, 'fat_g') - sumOf(gone, 'fat_g')),
  };

  const targets = json(planTargets(user.id), {});
  const dayKcal = dayTotals(user.id, date).planned.kcal;
  const budget = targets.kcal || dayKcal || 1800;
  const kcalDriftPct = budget ? Math.abs(delta.kcal) / budget : 0;

  const reasons = [];
  if (blocking.length) reasons.push(...blocking.map((c) => c.reason));
  if (kcalDriftPct > 0.15) {
    reasons.push(`Swap moves the day by ${delta.kcal > 0 ? '+' : ''}${delta.kcal} kcal (${Math.round(kcalDriftPct * 100)}% of the day's budget), past the 15% auto-apply limit.`);
  }
  if (!additions.length && !removals.length && !moves.length) reasons.push('Proposal changes nothing.');
  if (additions.some((a) => a.macro_source === 'estimated')) {
    reasons.push('Macros for one or more added items are estimated, not from the plan.');
  }

  return {
    date, removals, additions, moves, delta, conflicts, blocking,
    kcalDriftPct: round(kcalDriftPct * 100) / 100,
    valid: blocking.length === 0,
    reasons,
  };
}

function sumOf(rows, k) {
  return rows.reduce((t, r) => t + (Number(r[k]) || 0), 0);
}

/**
 * Decide the fate of a proposal. Hard conflicts are refused outright — a
 * model's confidence is irrelevant to them. Otherwise confidence and the
 * engine's own reasons decide auto-apply vs. dietitian review.
 */
export function gate({ validation, confidence }) {
  if (!validation.valid) {
    return { decision: 'rejected', reason: validation.blocking.map((c) => c.reason).join(' ') };
  }
  if (confidence >= AUTO_APPLY_THRESHOLD && validation.reasons.length === 0) {
    return { decision: 'auto_applied', reason: `Confidence ${(confidence * 100).toFixed(0)}% and no engine objections.` };
  }
  return {
    decision: 'pending',
    reason: validation.reasons.length
      ? validation.reasons.join(' ')
      : `Confidence ${(confidence * 100).toFixed(0)}% is below the ${AUTO_APPLY_THRESHOLD * 100}% auto-apply threshold.`,
  };
}

/** Apply a validated swap. Call only after gate() says so. */
export function applySwap(user, validation) {
  for (const e of validation.removals) {
    run("UPDATE plan_entries SET status = 'swapped' WHERE id = ?", e.id);
  }

  // Moves: off today's plate, onto the target day.
  for (const { entry, to } of validation.moves || []) {
    run("UPDATE plan_entries SET status = 'swapped' WHERE id = ?", entry.id);
    insert('plan_entries', {
      user_id: user.id, date: to, slot: entry.slot, time_hint: entry.time_hint,
      plan_item_id: entry.plan_item_id, name: entry.name, qty: entry.qty, unit: entry.unit,
      kcal: entry.kcal, protein_g: entry.protein_g, carbs_g: entry.carbs_g, fat_g: entry.fat_g,
      macro_source: entry.macro_source, status: 'planned',
      swapped_from: `moved from ${validation.date}`,
    });
  }
  const ids = [];
  for (const a of validation.additions) {
    ids.push(insert('plan_entries', {
      user_id: user.id, date: validation.date, slot: a.slot, time_hint: a.time_hint || null,
      name: a.name, qty: a.qty, unit: a.unit || null,
      kcal: a.kcal, protein_g: a.protein_g, carbs_g: a.carbs_g, fat_g: a.fat_g,
      macro_source: a.macro_source, status: 'added',
      swapped_from: validation.removals.map((r) => r.name).join(', ') || null,
    }));
  }
  return ids;
}

/** Mark a planned entry eaten. The only place status becomes 'eaten'. */
export function markEaten(entryId) {
  run("UPDATE plan_entries SET status = 'eaten' WHERE id = ?", entryId);
}

/**
 * Record food the user ate that was not on the plan. This is a fact, not a
 * plan change: it shows on the day in its own colour and counts towards
 * consumption, but never towards the plan or adherence. `flag` carries any
 * conflict with the user's diet or allergies so it is visible where it sits.
 */
export function recordOffPlan(userId, date, slot, item, flag = null) {
  const m = withMacros(item);
  return insert('plan_entries', {
    user_id: userId, date, slot: normaliseSlot(slot), time_hint: null,
    name: item.name, qty: item.qty ?? 1, unit: item.unit || null,
    kcal: m.kcal, protein_g: m.protein_g, carbs_g: m.carbs_g, fat_g: m.fat_g,
    macro_source: m.macro_source, status: 'offplan', flag,
  });
}

export function planTargets(userId) {
  const plan = get('SELECT targets_json FROM plans WHERE user_id = ? ORDER BY id DESC LIMIT 1', userId);
  return plan ? plan.targets_json : '{}';
}

export function activePlan(userId) {
  return get('SELECT * FROM plans WHERE user_id = ? ORDER BY id DESC LIMIT 1', userId);
}

/* ------------------------------------------------------------------ *
 * Behaviour change score — rules and arithmetic only. The model is
 * allowed to narrate this, never to compute it.
 * ------------------------------------------------------------------ */

export function behaviourScore(userId, endDate = today()) {
  // Today is still in progress — scoring a partially-eaten day as a miss would
  // punish every user every morning. Windows end yesterday; streak and silence
  // are still measured from today.
  const windowEnd = addDays(endDate, -1);

  const adh7 = adherenceWindow(userId, windowEnd, 7);
  const adh28 = adherenceWindow(userId, windowEnd, 28);

  const logged7 = get(
    'SELECT COUNT(DISTINCT date) AS n FROM checkins WHERE user_id = ? AND date > ? AND date <= ?',
    userId, addDays(windowEnd, -7), windowEnd,
  ).n;

  const st = streak(userId, endDate);
  const since = daysSinceLastCheckin(userId, endDate);

  // Momentum: the 7-day rate against the 28-day one. Steady sits at half marks;
  // a 25-point swing either way reaches the ends.
  const momentum = clamp01(0.5 + (adh7 - adh28) * 2);

  // Four components, each of which actually moves with what the user does.
  // "Dietary variety" used to sit here and was dropped: against a repeating
  // 6-day plan it measures the dietitian's plan, not the person, and scored
  // full marks for every user including a lapsed one.
  const components = [
    { key: 'adherence', label: 'Plan adherence', weight: 0.45, value: adh7, display: `${Math.round(adh7 * 100)}%`, detail: 'of planned items eaten, last 7 days' },
    { key: 'consistency', label: 'Logging consistency', weight: 0.30, value: logged7 / 7, display: `${logged7} of 7 days`, detail: 'days with at least one check-in' },
    // Scored on a fixed scale so the number means the same thing for every
    // user. The personalised milestone ladder is a separate, motivational
    // device — scoring against a moving target would drop a user's score the
    // moment they hit a milestone and the next one appears.
    { key: 'streak', label: 'Current streak', weight: 0.15, value: Math.min(st / 21, 1), display: st === 1 ? '1 day' : `${st} days`, detail: 'scored out of 21 unbroken days' },
    { key: 'momentum', label: 'Momentum', weight: 0.10, value: momentum, display: trendLabel(adh7, adh28), detail: 'this week vs the 28-day average; steady is half marks' },
  ];

  // Score is the sum of the points shown, not a separately rounded total —
  // otherwise the parts on screen add up to something other than the headline.
  const scored = components.map((c) => ({
    ...c,
    max: Math.round(c.weight * 100),
    contribution: Math.round(c.weight * clamp01(c.value) * 100),
  }));
  const score = scored.reduce((t, c) => t + c.contribution, 0);

  // Lapsed is about recency, not arithmetic: five silent days is lapsed
  // whatever the historical average says.
  const band = since !== null && since >= 5 ? 'Lapsed'
    : score >= 75 ? 'Strong' : score >= 50 ? 'Building' : score >= 25 ? 'At risk' : 'Lapsed';

  return {
    score,
    band,
    components: scored,
    facts: { adherence7: adh7, adherence28: adh28, loggedDays7: logged7, streak: st, daysSinceLastCheckin: since },
  };
}

const clamp01 = (n) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

function trendLabel(a7, a28) {
  const d = Math.round((a7 - a28) * 100);
  if (d > 5) return `up ${d}`;
  if (d < -5) return `down ${Math.abs(d)}`;
  return 'steady';
}
