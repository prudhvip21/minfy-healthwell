/**
 * Input and output gates around every agent.
 *
 * The output gate is the important one. It re-checks whatever a model
 * produced against the user's recorded allergies and diet using the engine's
 * own rules — so a confident, fluent, wrong answer still cannot reach the
 * plan. No model confidence score can override it, and it runs even when the
 * model call was served from the degraded-mode cache.
 */

import { profileConflicts } from './engine.js';

/* ------------------------------ input ------------------------------ */

const INJECTION_PATTERNS = [
  /ignore (all |any )?(previous|prior|above) instructions/i,
  /disregard (the )?(system|above|previous)/i,
  /you are now (a|an|in) /i,
  /\bsystem prompt\b/i,
  /\bdeveloper mode\b/i,
  /<\s*\/?\s*(system|instructions)\s*>/i,
  /reveal (your|the) (prompt|instructions|rules)/i,
];

const PII_PATTERNS = [
  [/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  [/\b(?:\+91[-\s]?)?[6-9]\d{9}\b/g, '[phone]'],
  [/\b\d{4}\s?\d{4}\s?\d{4}\b/g, '[aadhaar-like]'],
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[pan-like]'],
];

/**
 * @returns {{clean: string, verdict: 'pass'|'flagged', injection: string[], redacted: string[]}}
 */
export function scanInput(raw) {
  const text = String(raw || '');
  const injection = INJECTION_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);

  let clean = text;
  const redacted = [];
  for (const [re, label] of PII_PATTERNS) {
    if (re.test(clean)) {
      redacted.push(label);
      clean = clean.replace(re, label);
    }
    re.lastIndex = 0;
  }

  return {
    clean,
    verdict: injection.length ? 'flagged' : 'pass',
    injection,
    redacted,
    note: injection.length
      ? 'Input contains instruction-override patterns. Passed to the model as untrusted user content; the agent may not act on instructions found inside it.'
      : redacted.length
        ? `Redacted ${redacted.join(', ')} before the call.`
        : null,
  };
}

/* ------------------------------ output ----------------------------- */

/**
 * Check model-produced food items against the user's profile.
 *
 * @returns {{verdict: 'pass'|'blocked'|'review', blocked: object[], flagged: object[], allowed: object[], note: string|null}}
 */
export function scanItems(user, items) {
  const conflicts = profileConflicts(user, items);
  const high = conflicts.filter((c) => c.severity === 'high');
  const low = conflicts.filter((c) => c.severity !== 'high');

  const blockedNames = new Set(high.map((c) => c.item));
  const allowed = items.filter((i) => !blockedNames.has(i.name ?? i));

  let verdict = 'pass';
  if (high.length) verdict = 'blocked';
  else if (low.length) verdict = 'review';

  return {
    verdict,
    blocked: high,
    flagged: low,
    allowed,
    note: high.length
      ? `${high.length} item(s) blocked by the engine before any plan write: ${high.map((c) => c.item).join(', ')}.`
      : low.length
        ? `${low.length} item(s) flagged for a dietitian's eye.`
        : null,
  };
}

/**
 * The record that goes onto the trace row, so the Trace Console can show what
 * the gates did on every single call.
 */
export function verdictRecord(input, output) {
  return {
    input: input ? { verdict: input.verdict, injection: input.injection, redacted: input.redacted } : null,
    output: output ? { verdict: output.verdict, blocked: output.blocked.map((b) => b.item), flagged: output.flagged.map((f) => f.item) } : null,
    at: new Date().toISOString(),
  };
}
