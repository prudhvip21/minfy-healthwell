import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { all, get, run, json, ROOT } from './db.js';
import { hasKey, MODELS, transcribe } from './openai.js';
import {
  dayEntries, dayTotals, behaviourScore, today, addDays, activePlan, streak, daysSinceLastCheckin, SLOTS,
} from './engine.js';
import { importPlans, needsBootstrap, listPlanFiles } from './planImport.js';
import { resetDemo } from './reset.js';
import { extractAndLog, logSelection } from './agents/logging.js';
import { proposeAdjustment, decide, reviewQueue } from './agents/planswap.js';
import { detectSignals, generateNudges, listNudges, markNudge, TONE_BANDS } from './agents/trigger.js';
import { generateReward, streakTarget } from './agents/reward.js';
import { narrateScore, scoreHistory, explainEntry, funnel } from './agents/insights.js';
import { chat } from './agents/assistant.js';

const app = express();
app.use(express.json({ limit: '25mb' }));   // photos and voice notes arrive as base64

const PORT = Number(process.env.PORT) || 4000;

/* ------------------------------------------------------------------ *
 * API layer: partner scoping and rate limits.
 *
 * Every request may carry x-partner-id. The partner's configuration decides
 * which use cases it can reach and how often — the same services, exposed
 * as a configured subset. No header means first party.
 * ------------------------------------------------------------------ */

const USE_CASE_BY_PREFIX = [
  ['/api/checkin', 'checkin'], ['/api/transcribe', 'checkin'],
  ['/api/plan/propose', 'planloop'], ['/api/review', 'planloop'],
  ['/api/nudges', 'nudges'], ['/api/assistant', 'assistant'],
  ['/api/score', 'score'], ['/api/explain', 'explain'],
];

const hits = new Map();   // partnerId → { windowStart, count }

app.use('/api', (req, res, next) => {
  const partnerId = req.get('x-partner-id');
  if (!partnerId) return next();

  const partner = get('SELECT * FROM partners WHERE id = ?', partnerId);
  if (!partner) return res.status(401).json({ error: `Unknown partner "${partnerId}".` });

  const full = `/api${req.path}`;
  const useCase = USE_CASE_BY_PREFIX.find(([p]) => full.startsWith(p))?.[1];
  const enabled = json(partner.enabled_json, []);
  if (useCase && !enabled.includes(useCase)) {
    return res.status(403).json({
      error: `"${useCase}" is not enabled for ${partner.name}.`,
      partner: partner.id, enabled,
    });
  }

  const now = Date.now();
  const h = hits.get(partnerId) || { windowStart: now, count: 0 };
  if (now - h.windowStart > 60_000) { h.windowStart = now; h.count = 0; }
  h.count += 1;
  hits.set(partnerId, h);
  res.set('x-ratelimit-limit', String(partner.rate_limit));
  res.set('x-ratelimit-remaining', String(Math.max(0, partner.rate_limit - h.count)));
  if (h.count > partner.rate_limit) {
    return res.status(429).json({ error: `Rate limit of ${partner.rate_limit}/min reached for ${partner.name}.` });
  }

  req.partner = partner;
  next();
});

/* ------------------------------ helpers ---------------------------- */

function userOr404(req, res) {
  const id = req.params.userId || req.body?.userId || req.query.userId;
  const user = id && get('SELECT * FROM users WHERE id = ?', id);
  if (!user) {
    res.status(404).json({ error: `No such user "${id}".` });
    return null;
  }
  return user;
}

function publicUser(u) {
  return {
    ...u,
    conditions: json(u.conditions_json, []),
    allergies: json(u.allergies_json, []),
  };
}

/** Wrap async handlers so a thrown error becomes a JSON 500 with its trace id. */
const h = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error(`[${req.method} ${req.path}]`, err.message);
  if (!res.headersSent) {
    res.status(err.status && err.status < 600 ? err.status : 500).json({
      error: err.message,
      traceId: err.traceId ?? null,
      hint: !hasKey() ? 'OPENAI_API_KEY is not set — add it to .env and restart.' : undefined,
    });
  }
});

/* ------------------------------ system ----------------------------- */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true, hasKey: hasKey(), models: MODELS, today: today(),
    planFiles: listPlanFiles(),
    plans: all('SELECT user_id, source_file, parse_status, parse_note, duration_days FROM plans'),
  });
});

app.post('/api/reset', h(async (req, res) => {
  const lines = [];
  const report = await resetDemo({ reparse: Boolean(req.body?.reparse), log: (l) => lines.push(l) });
  res.json({ report, log: lines });
}));

app.post('/api/import', h(async (req, res) => {
  const lines = [];
  const report = await importPlans({ force: Boolean(req.body?.force), log: (l) => lines.push(l) });
  res.json({ report, log: lines });
}));

/* ------------------------------- users ----------------------------- */

app.get('/api/users', (req, res) => {
  res.json(all('SELECT * FROM users ORDER BY rowid').map((u) => {
    const s = behaviourScore(u.id);
    return {
      ...publicUser(u),
      score: s.score, band: s.band,
      streak: streak(u.id), silent: daysSinceLastCheckin(u.id),
      pendingReviews: get("SELECT COUNT(*) AS n FROM plan_changes WHERE user_id = ? AND status = 'pending'", u.id).n,
    };
  }));
});

/* ------------------------------- plan ------------------------------ */

app.get('/api/plan/:userId', (req, res) => {
  const user = userOr404(req, res); if (!user) return;
  const date = req.query.date || today();
  const plan = activePlan(user.id);
  const entries = dayEntries(user.id, date);

  const bySlot = SLOTS
    .map((slot) => ({ slot, items: entries.filter((e) => e.slot === slot) }))
    .filter((g) => g.items.length);

  res.json({
    date, user: publicUser(user),
    plan: plan && {
      id: plan.id, source_file: plan.source_file, parse_status: plan.parse_status,
      parse_note: plan.parse_note, cycle_days: plan.duration_days,
      targets: json(plan.targets_json, {}), guidance: json(plan.guidance_json, []),
    },
    totals: dayTotals(user.id, date),
    slots: bySlot,
    streak: streakTarget(user.id),
  });
});

/* ----------------------------- check-in ---------------------------- */

app.post('/api/transcribe', h(async (req, res) => {
  const user = userOr404(req, res); if (!user) return;
  const { audioBase64, mime = 'audio/webm', seconds = null } = req.body;
  if (!audioBase64) return res.status(400).json({ error: 'audioBase64 is required' });
  const ext = mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : 'webm';
  const result = await transcribe({
    buffer: Buffer.from(audioBase64, 'base64'), filename: `note.${ext}`, userId: user.id, seconds,
  });
  res.json(result);
}));

/**
 * The full daily check-in loop in one request:
 * (transcribe) → logging agent → engine match → guardrails → reward,
 * and, if anything was off-plan, the plan-swap agent → engine gate.
 */
app.post('/api/checkin', h(async (req, res) => {
  const user = userOr404(req, res); if (!user) return;
  const {
    modality = 'text', imageDataUrl = null, audioBase64 = null, mime, seconds,
    autoAdjust = true, reward: wantReward = true,
  } = req.body;
  let { text = '' } = req.body;

  let transcript = null;
  if (modality === 'voice' && audioBase64) {
    const ext = String(mime || '').includes('mp4') ? 'mp4' : 'webm';
    transcript = await transcribe({ buffer: Buffer.from(audioBase64, 'base64'), filename: `note.${ext}`, userId: user.id, seconds });
    text = transcript.text;
  }

  if (!text && !imageDataUrl) return res.status(400).json({ error: 'Send text, a photo, or a voice note.' });

  const logged = await extractAndLog({ user, modality, text, imageDataUrl, slot: req.body.slot || null });

  // Reward and plan adjustment are independent — run them together.
  const [reward, adjustment] = await Promise.all([
    wantReward
      ? generateReward({ user, checkinResult: logged }).catch((e) => ({ error: e.message }))
      : Promise.resolve(null),
    autoAdjust && logged.unplanned.length
      ? proposeAdjustment({ user, unplanned: logged.unplanned, trigger: 'checkin' }).catch((e) => ({ error: e.message }))
      : Promise.resolve(null),
  ]);

  res.json({ transcript, logged, reward, adjustment, plan: dayTotals(user.id, today()) });
}));

/** Menu-style check-in: tick items off the plan, plus optional free-text extras. */
app.post('/api/checkin/select', h(async (req, res) => {
  const user = userOr404(req, res); if (!user) return;
  const { slot, entryIds = [], extras = '', reward: wantReward = true } = req.body;

  const logged = await logSelection({ user, slot, entryIds: entryIds.map(Number), extras });
  if (!logged.items.length) return res.status(400).json({ error: 'Nothing selected.' });

  const reward = wantReward
    ? await generateReward({ user, checkinResult: logged }).catch((e) => ({ error: e.message }))
    : null;

  res.json({ transcript: null, logged, reward, adjustment: null, plan: dayTotals(user.id, today()) });
}));

/* ---------------------------- plan loop ---------------------------- */

/** Readjust the day from what actually happened — no meal input needed. */
app.post('/api/plan/readjust', h(async (req, res) => {
  const user = userOr404(req, res); if (!user) return;
  res.json(await proposeAdjustment({ user, date: req.body.date || today(), trigger: 'readjust' }));
}));

app.post('/api/plan/propose', h(async (req, res) => {
  const user = userOr404(req, res); if (!user) return;
  const result = await proposeAdjustment({
    user, unplanned: req.body.unplanned || [], trigger: req.body.trigger || 'manual',
  });
  res.json(result);
}));

app.get('/api/review', (req, res) => {
  res.json(reviewQueue(req.query.userId || null));
});

app.post('/api/review/:id/decide', h(async (req, res) => {
  const { decision, reviewer } = req.body;
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "approved" or "rejected"' });
  }
  res.json(decide({ changeId: Number(req.params.id), decision, reviewer }));
}));

/* ------------------------------ nudges ----------------------------- */

const parseOverride = (v) => (v === null || v === undefined || v === '' ? null : Math.max(0, Math.min(1, Number(v))));

app.get('/api/nudges/:userId', (req, res) => {
  const user = userOr404(req, res); if (!user) return;
  res.json({
    signals: detectSignals(user, { adherenceOverride: parseOverride(req.query.adherence) }),
    nudges: listNudges(user.id), bands: TONE_BANDS.map(({ key, label, range, escalate }) => ({ key, label, range, escalate: !!escalate })),
  });
});

app.post('/api/nudges/:userId/generate', h(async (req, res) => {
  const user = userOr404(req, res); if (!user) return;
  res.json(await generateNudges({ user, count: req.body?.count || 3, adherenceOverride: parseOverride(req.body?.adherence) }));
}));

app.post('/api/nudges/item/:id/status', h(async (req, res) => {
  const { status } = req.body;
  if (!['sent', 'opened', 'ignored', 'queued', 'escalated'].includes(status)) {
    return res.status(400).json({ error: 'bad status' });
  }
  res.json(markNudge(Number(req.params.id), status));
}));

/* ------------------------------ score ------------------------------ */

app.get('/api/score/:userId', (req, res) => {
  const user = userOr404(req, res); if (!user) return;
  res.json({ ...behaviourScore(user.id), history: scoreHistory(user.id), streak: streakTarget(user.id) });
});

app.post('/api/score/:userId/narrate', h(async (req, res) => {
  const user = userOr404(req, res); if (!user) return;
  res.json(await narrateScore({ user }));
}));

app.get('/api/funnel', (req, res) => res.json(funnel()));

/* ----------------------------- explain ----------------------------- */

app.post('/api/explain/:userId/:entryId', h(async (req, res) => {
  const user = userOr404(req, res); if (!user) return;
  res.json(await explainEntry({ user, entryId: Number(req.params.entryId) }));
}));

/* ---------------------------- assistant ---------------------------- */

app.post('/api/assistant', async (req, res) => {
  const user = userOr404(req, res); if (!user) return;

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  await chat({
    user, message: String(req.body.message || ''), previousResponseId: req.body.previousResponseId || null, emit,
  }).catch((err) => emit('error', { message: err.message }));
  res.end();
});

/* ------------------------------ traces ----------------------------- */

app.get('/api/traces', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = req.query.userId
    ? all('SELECT * FROM traces WHERE user_id = ? ORDER BY id DESC LIMIT ?', req.query.userId, limit)
    : all('SELECT * FROM traces ORDER BY id DESC LIMIT ?', limit);

  const totals = get(`SELECT COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                             SUM(cost_usd) AS cost_usd, AVG(latency_ms) AS avg_latency,
                             SUM(status = 'degraded') AS degraded, SUM(status = 'error') AS errors
                        FROM traces`);

  res.json({
    totals,
    traces: rows.map((t) => ({
      ...t,
      input: json(t.input_json, null),
      output: json(t.output_json, null),
      toolCalls: json(t.tool_calls_json, null),
      guardrail: json(t.guardrail_json, null),
    })),
  });
});

app.get('/api/traces/:id', (req, res) => {
  const t = get('SELECT * FROM traces WHERE id = ?', Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'no such trace' });
  res.json({ ...t, input: json(t.input_json, null), output: json(t.output_json, null), toolCalls: json(t.tool_calls_json, null), guardrail: json(t.guardrail_json, null) });
});

/* ----------------------------- partners ---------------------------- */

app.get('/api/partners', (req, res) => {
  res.json(all('SELECT * FROM partners').map((p) => ({
    ...p, brand: json(p.brand_json, {}), enabled: json(p.enabled_json, []), active: Boolean(p.active),
  })));
});

app.put('/api/partners/:id', (req, res) => {
  const p = get('SELECT * FROM partners WHERE id = ?', req.params.id);
  if (!p) return res.status(404).json({ error: 'no such partner' });
  const { enabled, rate_limit, brand } = req.body;
  if (enabled) run('UPDATE partners SET enabled_json = ? WHERE id = ?', JSON.stringify(enabled), p.id);
  if (rate_limit) run('UPDATE partners SET rate_limit = ? WHERE id = ?', Number(rate_limit), p.id);
  if (brand) run('UPDATE partners SET brand_json = ? WHERE id = ?', JSON.stringify(brand), p.id);
  hits.delete(p.id);
  res.json({ ok: true });
});

/* --------------------------- static build -------------------------- */

const dist = path.join(ROOT, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

/* ------------------------------ boot ------------------------------- */

/**
 * True when the seeded history is missing or older than yesterday — either
 * the demo sat overnight, or a reset was interrupted partway.
 */
function isHistoryStale() {
  if (!get('SELECT COUNT(*) AS n FROM users').n) return false;
  const row = get('SELECT MAX(date) AS d FROM checkins');
  return !row?.d || row.d < addDays(today(), -1);
}

async function boot() {
  if (needsBootstrap()) {
    console.log('Empty database — bootstrapping users, plans and history …');
    await importPlans();
  } else if (isHistoryStale()) {
    // Seeded history is relative to "today". Left overnight, the personas drift
    // (a 20-day streak reads as 0), so rebuild it. Parsed plans are kept, so
    // this costs nothing at the API.
    console.log('Seeded history is from a previous day — refreshing demo state …');
    await resetDemo({ log: () => {} });
  } else if (hasKey() && listPlanFiles().length
    && all("SELECT id FROM plans WHERE parse_status != 'parsed'").length) {
    // A key has appeared since users were put on fallback plans: parse the real
    // documents now. Unchanged, already-parsed documents are skipped.
    console.log('OPENAI_API_KEY found and some users are on fallback plans — parsing plan documents …');
    await importPlans();
  }
  app.listen(PORT, () => {
    console.log(`HealthWise API on http://localhost:${PORT}  (key: ${hasKey() ? 'set' : 'MISSING — add OPENAI_API_KEY to .env'})`);
  });
}

boot().catch((e) => { console.error(e); process.exit(1); });
