/**
 * Demo users and their history.
 *
 * The three personas are chosen against the contents of the real dietitian
 * document in plans/: one user it suits cleanly, one whose allergy and diet
 * collide with specific items in it, and one who has stopped logging. Between
 * them every screen has a story that needs no explaining.
 */

import { all, get, insert, run } from './db.js';
import { addDays, isoDate, today, dayEntries } from './engine.js';

export const PERSONAS = [
  {
    id: 'ananya',
    name: 'Ananya Sharma',
    age: 32, sex: 'F',
    goal: 'Fat loss with PCOS management',
    conditions_json: ['PCOS', 'Insulin resistance'],
    diet: 'lacto-vegetarian',
    allergies_json: ['peanut'],
    persona: 'High adherer, logs every day',
    cohort: 'Feb-2026',
    avatar: '🌿',
    // Climbing: 0.62 → 0.95 across the window, logs every day.
    curve: (i, n) => ({ adherence: 0.62 + (0.33 * i) / (n - 1), logs: true }),
  },
  {
    id: 'rohit',
    name: 'Rohit Menon',
    age: 41, sex: 'M',
    goal: 'Pre-diabetes reversal (HbA1c 6.1)',
    conditions_json: ['Pre-diabetic', 'Hypertension'],
    diet: 'non-vegetarian',
    allergies_json: [],
    persona: 'Mid adherer, travels, eats off-plan',
    cohort: 'Feb-2026',
    avatar: '✈️',
    // Sawtooth around 0.55, misses roughly two days a week.
    curve: (i) => ({
      adherence: 0.4 + 0.3 * Math.abs(Math.sin(i * 1.1)),
      logs: i % 7 !== 2 && i % 7 !== 5,
    }),
  },
  {
    id: 'meera',
    name: 'Meera Iyer',
    age: 27, sex: 'F',
    goal: 'Weight maintenance and energy',
    conditions_json: ['Lactose intolerance', 'Low ferritin'],
    diet: 'vegetarian',
    allergies_json: ['dairy'],
    persona: 'Strong start, silent for 6 days',
    cohort: 'Jan-2026',
    avatar: '🌙',
    // Good for two weeks, then falls off a cliff and stops entirely.
    // n-5 puts her last check-in 6 days ago, matching the persona label.
    curve: (i, n) => (i < n - 5
      ? { adherence: 0.85 - 0.02 * i, logs: true }
      : { adherence: 0, logs: false }),
  },
];

export const HISTORY_DAYS = 21;

export function ensureUsers() {
  const existing = get('SELECT COUNT(*) AS n FROM users').n;
  if (existing > 0) return all('SELECT * FROM users');

  const start = addDays(today(), -(HISTORY_DAYS - 1));
  for (const p of PERSONAS) {
    insert('users', {
      id: p.id, name: p.name, age: p.age, sex: p.sex, goal: p.goal,
      conditions_json: p.conditions_json, diet: p.diet, allergies_json: p.allergies_json,
      persona: p.persona, cohort: p.cohort, start_date: start, avatar: p.avatar,
    });
  }
  return all('SELECT * FROM users');
}

/**
 * Walk the materialised plan and mark items eaten according to the persona's
 * curve, writing the check-ins and events that would have produced them.
 * Everything downstream — adherence, score, nudges, funnel — reads this.
 */
export function seedHistory(user) {
  const persona = PERSONAS.find((p) => p.id === user.id);
  if (!persona) return 0;

  const already = get('SELECT COUNT(*) AS n FROM checkins WHERE user_id = ?', user.id).n;
  if (already > 0) return 0;

  const n = HISTORY_DAYS;
  let written = 0;

  for (let i = 0; i < n; i += 1) {
    // i = 0 is the oldest day; the window ends yesterday.
    const date = addDays(today(), -(n - i));
    const { adherence, logs } = persona.curve(i, n);
    if (!logs || adherence <= 0) continue;

    const entries = dayEntries(user.id, date);
    if (!entries.length) continue;

    const take = Math.max(1, Math.round(entries.length * adherence));
    const eaten = entries.slice(0, take);

    const checkinId = insert('checkins', {
      user_id: user.id, date, slot: null,
      modality: i % 3 === 0 ? 'photo' : i % 3 === 1 ? 'voice' : 'text',
      raw_text: `Seeded history — ${take} of ${entries.length} planned items`,
      created_at: `${date} 20:30:00`,
    });

    for (const e of eaten) {
      run("UPDATE plan_entries SET status = 'eaten' WHERE id = ?", e.id);
      insert('checkin_items', {
        checkin_id: checkinId, user_id: user.id, name: e.name, qty: e.qty, unit: e.unit,
        kcal: e.kcal, protein_g: e.protein_g, carbs_g: e.carbs_g, fat_g: e.fat_g,
        confidence: 0.9, verdict: 'matched', matched_entry_id: e.id,
      });
    }

    // Off-plan meals are Rohit's defining behaviour — they drive the swap loop.
    if (user.id === 'rohit' && i % 4 === 3) {
      const offPlan = ['Chicken biryani - 1.5 cup', 'Masala dosa - 2no', 'Filter coffee with sugar - 1cup'][i % 3];
      insert('checkin_items', {
        checkin_id: checkinId, user_id: user.id, name: offPlan, qty: 1, unit: 'serving',
        kcal: 480, protein_g: 18, carbs_g: 62, fat_g: 17,
        confidence: 0.82, verdict: 'unplanned',
      });
    }

    insert('events', {
      user_id: user.id, type: 'checkin',
      payload_json: { date, items: take, adherence: Math.round(adherence * 100) / 100 },
      ts: `${date} 20:30:00`,
    });
    written += 1;
  }

  insert('events', {
    user_id: user.id, type: 'onboarded',
    payload_json: { cohort: user.cohort },
    ts: `${user.start_date} 09:00:00`,
  });

  return written;
}

/** Synthetic warehouse rows so the funnel isn't three data points wide. */
export function seedCohortStats() {
  if (get('SELECT COUNT(*) AS n FROM cohort_stats').n > 0) return;
  const cohorts = [
    { cohort: 'Dec-2025', total: 412, retention: [1, 0.58, 0.41, 0.33] },
    { cohort: 'Jan-2026', total: 486, retention: [1, 0.61, 0.44, 0.36] },
    { cohort: 'Feb-2026', total: 523, retention: [1, 0.64, 0.48, 0.39] },
  ];
  for (const c of cohorts) {
    c.retention.forEach((r, i) => {
      insert('cohort_stats', { cohort: c.cohort, week: i + 1, retained: Math.round(c.total * r), total: c.total });
    });
  }
}

export function seedPartners() {
  if (get('SELECT COUNT(*) AS n FROM partners').n > 0) return;
  insert('partners', {
    id: 'healthwise', name: 'HealthWise (first party)',
    brand_json: { primary: '#00B15D', logo: '🌱' },
    enabled_json: ['checkin', 'planloop', 'nudges', 'assistant', 'score', 'explain'],
    rate_limit: 10000, active: 1,
  });
  insert('partners', {
    id: 'apollo', name: 'Apollo Wellness (white label)',
    brand_json: { primary: '#1B6CC4', logo: '🏥' },
    enabled_json: ['checkin', 'planloop', 'explain'],
    rate_limit: 2000, active: 0,
  });
  insert('partners', {
    id: 'corpfit', name: 'CorpFit Employee Benefits',
    brand_json: { primary: '#7A3FBF', logo: '🏢' },
    enabled_json: ['checkin', 'nudges', 'score'],
    rate_limit: 500, active: 0,
  });
}
