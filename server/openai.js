/**
 * The single chokepoint for every model call in the system.
 *
 * Nothing else in this codebase talks to OpenAI directly. That buys three
 * things the demo depends on: every call lands in the trace table with real
 * tokens and cost, every call can be replayed from cache if the network dies
 * mid-demo, and swapping models is a one-line change here.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import OpenAI from 'openai';
import { insert, DATA_DIR } from './db.js';

export const MODELS = {
  reason: process.env.MODEL_REASON || 'gpt-5',
  transcribe: process.env.MODEL_TRANSCRIBE || 'whisper-1',
};

/**
 * Published list prices, USD per 1M tokens. These are a configured constant,
 * not a live lookup — if OpenAI's pricing moves, change it here. The trace
 * console is honest about that: it labels the column "est. cost".
 */
const PRICING = {
  'gpt-5': { in: 1.25, out: 10.0 },
  'gpt-5-mini': { in: 0.25, out: 2.0 },
  'gpt-5-nano': { in: 0.05, out: 0.4 },
};
const WHISPER_PER_MINUTE = 0.006;

let client = null;
export function openai() {
  if (!client) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set — put it in .env at the project root.');
    }
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120_000, maxRetries: 1 });
  }
  return client;
}

export function hasKey() {
  return Boolean(process.env.OPENAI_API_KEY);
}

/* ------------------------------------------------------------------ *
 * Demo insurance: successful responses are kept on disk keyed by route,
 * user AND a hash of the exact request. If a live call fails, only an
 * identical earlier request can be replayed — so rehearsing a demo once
 * makes that exact click safe, but a cached answer is never passed off
 * as the answer to a different question. It is never used while live
 * calls are working, and the UI marks it in amber when it is.
 * ------------------------------------------------------------------ */

const CACHE_PATH = path.join(DATA_DIR, 'last-good.json');

export function cacheKey(route, userId, request) {
  const h = crypto.createHash('sha1').update(JSON.stringify(request)).digest('hex').slice(0, 16);
  return `${route}:${userId || '-'}:${h}`;
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { return {}; }
}

function writeCache(route, payload) {
  try {
    const cache = readCache();
    cache[route] = { payload, at: new Date().toISOString() };
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch { /* cache is a convenience; never fail a request over it */ }
}

/* ------------------------------------------------------------------ */

function cost(model, usage) {
  const p = PRICING[model];
  if (!p || !usage) return null;
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  return Number(((inTok / 1e6) * p.in + (outTok / 1e6) * p.out).toFixed(6));
}

/** The SDK exposes output_text, but walk the blocks if it is ever absent. */
function outputText(response) {
  if (typeof response.output_text === 'string' && response.output_text) return response.output_text;
  const parts = [];
  for (const item of response.output || []) {
    for (const c of item.content || []) {
      if (c.type === 'output_text' && c.text) parts.push(c.text);
    }
  }
  return parts.join('');
}

/**
 * Wrap a JSON schema in the shape the Responses API expects. Strict mode
 * requires every property to be listed in `required` and additionalProperties
 * false, so this asserts that rather than letting the API reject it later.
 */
export function jsonSchema(name, schema) {
  assertStrict(schema, name);
  return { type: 'json_schema', name, schema, strict: true };
}

function assertStrict(node, where) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'object') {
    if (node.additionalProperties !== false) {
      throw new Error(`schema ${where}: every object needs additionalProperties:false for strict mode`);
    }
    const props = Object.keys(node.properties || {});
    const required = node.required || [];
    const missing = props.filter((p) => !required.includes(p));
    if (missing.length) {
      throw new Error(`schema ${where}: strict mode requires every property in "required" — missing ${missing.join(', ')}`);
    }
    for (const [k, v] of Object.entries(node.properties || {})) assertStrict(v, `${where}.${k}`);
  }
  if (node.type === 'array') assertStrict(node.items, `${where}[]`);
}

/**
 * Run one model call, trace it, and return { data, trace, degraded }.
 *
 * @param {object} o
 * @param {string} o.route        stable name, e.g. 'logging.photo' — also the cache key
 * @param {string} [o.system]     instructions
 * @param {string|Array} o.input  Responses API input
 * @param {object} [o.format]     jsonSchema(...) result; when given, data is parsed JSON
 * @param {string} [o.effort]     minimal | low | medium | high
 * @param {string} [o.verbosity]  low | medium | high
 * @param {Array}  [o.tools]
 * @param {string} [o.userId]
 * @param {number} [o.confidence] overrides the confidence recorded on the trace
 */
export async function callModel({
  route, system, input, format, effort = 'medium', verbosity = 'low',
  tools, userId = null, model = MODELS.reason, maxOutput = 8000, guardrail = null, timeoutMs = 120_000,
}) {
  const started = Date.now();
  const request = {
    model,
    input,
    ...(system ? { instructions: system } : {}),
    ...(format ? { text: { format, verbosity } } : { text: { verbosity } }),
    ...(tools ? { tools } : {}),
    reasoning: { effort },
    max_output_tokens: maxOutput,
  };
  const key = cacheKey(route, userId, { model, input, system, format: format?.name });

  try {
    const response = await openai().responses.create(request, { timeout: timeoutMs });
    if (response.status === 'incomplete') {
      // Reasoning tokens count against max_output_tokens on GPT-5; say so plainly
      // rather than failing later on half a JSON document.
      const why = response.incomplete_details?.reason || 'unknown';
      throw new Error(`${route}: response incomplete (${why}) — raise maxOutput or lower effort`);
    }
    const text = outputText(response);

    let data = text;
    if (format) {
      try {
        data = JSON.parse(text);
      } catch (err) {
        throw new Error(`model returned unparseable JSON for ${route}: ${text.slice(0, 300)}`);
      }
    }

    const toolCalls = (response.output || []).filter((o) => o.type === 'function_call');
    const traceId = insert('traces', {
      user_id: userId, route, model, effort,
      input_json: JSON.stringify({ system, input: summarise(input) }),
      output_json: JSON.stringify(data).slice(0, 20000),
      tool_calls_json: toolCalls.length ? JSON.stringify(toolCalls) : null,
      latency_ms: Date.now() - started,
      input_tokens: response.usage?.input_tokens ?? null,
      output_tokens: response.usage?.output_tokens ?? null,
      cost_usd: cost(model, response.usage),
      confidence: typeof data?.confidence === 'number' ? data.confidence : null,
      guardrail_json: guardrail ? JSON.stringify(guardrail) : null,
      status: 'ok',
    });

    writeCache(key, data);
    return { data, traceId, degraded: false, raw: response };
  } catch (err) {
    const cached = readCache()[key];
    const traceId = insert('traces', {
      user_id: userId, route, model, effort,
      input_json: JSON.stringify({ system, input: summarise(input) }),
      output_json: cached ? JSON.stringify(cached.payload).slice(0, 20000) : null,
      latency_ms: Date.now() - started,
      status: cached ? 'degraded' : 'error',
      error: String(err?.message || err).slice(0, 500),
    });

    if (cached) {
      return {
        data: cached.payload, traceId, degraded: true,
        degradedNote: `Live call failed (${shortError(err)}). Replayed the response to this identical request, recorded ${cached.at}.`,
      };
    }
    err.traceId = traceId;
    throw err;
  }
}

/**
 * Record a trace for a call made outside callModel — the assistant streams,
 * so it drives the client itself but must still land in the same table.
 */
export function recordTrace({ route, userId, model = MODELS.reason, effort, input, output, toolCalls, usage, startedAt, status = 'ok', error = null }) {
  return insert('traces', {
    user_id: userId, route, model, effort,
    input_json: JSON.stringify(summarise(input)),
    output_json: output == null ? null : JSON.stringify(output).slice(0, 20000),
    tool_calls_json: toolCalls?.length ? JSON.stringify(toolCalls) : null,
    latency_ms: Date.now() - startedAt,
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
    cost_usd: cost(model, usage),
    status, error,
  });
}

export function lastGood(route) {
  return readCache()[route] || null;
}

export function rememberGood(route, payload) {
  writeCache(route, payload);
}

/** Transcribe an audio buffer. Whisper, per the agreed stack. */
export async function transcribe({ buffer, filename = 'note.webm', userId = null, seconds = null }) {
  const started = Date.now();
  const { toFile } = await import('openai');
  const key = cacheKey('voice.transcribe', userId, crypto.createHash('sha1').update(buffer).digest('hex'));
  try {
    const file = await toFile(buffer, filename);
    const result = await openai().audio.transcriptions.create({
      file, model: MODELS.transcribe, language: 'en',
    });
    const text = result.text || '';
    const traceId = insert('traces', {
      user_id: userId, route: 'voice.transcribe', model: MODELS.transcribe,
      input_json: JSON.stringify({ filename, bytes: buffer.length, seconds }),
      output_json: JSON.stringify({ text }),
      latency_ms: Date.now() - started,
      cost_usd: seconds ? Number(((seconds / 60) * WHISPER_PER_MINUTE).toFixed(6)) : null,
      status: 'ok',
    });
    writeCache(key, { text });
    return { text, traceId, degraded: false };
  } catch (err) {
    const cached = readCache()[key];
    const traceId = insert('traces', {
      user_id: userId, route: 'voice.transcribe', model: MODELS.transcribe,
      latency_ms: Date.now() - started,
      status: cached ? 'degraded' : 'error',
      error: String(err?.message || err).slice(0, 500),
    });
    if (cached) {
      return { text: cached.payload.text, traceId, degraded: true,
        degradedNote: `Transcription failed (${shortError(err)}). Replayed the transcript of this identical recording.` };
    }
    err.traceId = traceId;
    throw err;
  }
}

function shortError(err) {
  if (err?.status) return `HTTP ${err.status}`;
  const m = String(err?.message || err);
  return m.length > 80 ? `${m.slice(0, 80)}…` : m;
}

/** Keep base64 blobs out of the trace table. */
function summarise(input) {
  if (typeof input === 'string') return input.slice(0, 4000);
  return JSON.parse(JSON.stringify(input, (k, v) => {
    if (typeof v === 'string' && v.startsWith('data:')) return `${v.slice(0, 40)}…[${v.length} bytes]`;
    if (typeof v === 'string' && v.length > 4000) return `${v.slice(0, 4000)}…`;
    return v;
  }));
}
