"""
The single chokepoint for every model call in the system.

Nothing else talks to OpenAI directly. That buys three things the demo depends
on: every call lands in the trace table with real tokens and cost, a failed call
can replay the response to an identical earlier request, and swapping models is
a one-line change here.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time

from .db import DATA_DIR, insert, to_json
from .util import iso_now

MODELS = {
    'reason': os.environ.get('MODEL_REASON') or 'gpt-5',
    'transcribe': os.environ.get('MODEL_TRANSCRIBE') or 'whisper-1',
}

# Published list prices, USD per 1M tokens. A configured constant, not a live
# lookup — the Trace Console labels the column "est. cost" for that reason.
PRICING = {
    'gpt-5': {'in': 1.25, 'out': 10.0},
    'gpt-5-mini': {'in': 0.25, 'out': 2.0},
    'gpt-5-nano': {'in': 0.05, 'out': 0.4},
}
WHISPER_PER_MINUTE = 0.006

_client = None


def client():
    global _client
    if _client is None:
        key = os.environ.get('OPENAI_API_KEY')
        if not key:
            raise RuntimeError('OPENAI_API_KEY is not set — put it in .env at the project root.')
        from openai import OpenAI
        _client = OpenAI(api_key=key, timeout=120, max_retries=1)
    return _client


def has_key() -> bool:
    return bool(os.environ.get('OPENAI_API_KEY'))


# --------------------------------------------------------------------------
# Demo insurance: successful responses are kept on disk keyed by route, user
# AND a hash of the exact request. If a live call fails, only an identical
# earlier request can be replayed — a cached answer is never passed off as the
# answer to a different question, and the UI marks a replay in amber.
# --------------------------------------------------------------------------

CACHE_PATH = DATA_DIR / 'last-good.json'
_cache_lock = threading.Lock()


def cache_key(route: str, user_id, request) -> str:
    h = hashlib.sha1(to_json(request).encode('utf-8')).hexdigest()[:16]
    return f"{route}:{user_id or '-'}:{h}"


def _read_cache() -> dict:
    try:
        return json.loads(CACHE_PATH.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def _write_cache(key: str, payload) -> None:
    try:
        with _cache_lock:
            cache = _read_cache()
            cache[key] = {'payload': payload, 'at': iso_now()}
            CACHE_PATH.write_text(json.dumps(cache, indent=2, ensure_ascii=False, default=str), encoding='utf-8')
    except OSError:
        pass  # the cache is a convenience; never fail a request over it


def last_good(key: str):
    return _read_cache().get(key)


def remember_good(key: str, payload) -> None:
    _write_cache(key, payload)


# --------------------------------------------------------------------------

def _field(obj, name):
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def _cost(model: str, usage):
    p = PRICING.get(model)
    if not p or usage is None:
        return None
    in_tok = _field(usage, 'input_tokens') or 0
    out_tok = _field(usage, 'output_tokens') or 0
    return float(f"{(in_tok / 1e6) * p['in'] + (out_tok / 1e6) * p['out']:.6f}")


def _output_text(response) -> str:
    text = getattr(response, 'output_text', None)
    if isinstance(text, str) and text:
        return text
    parts = []
    for item in getattr(response, 'output', None) or []:
        for c in getattr(item, 'content', None) or []:
            if getattr(c, 'type', None) == 'output_text' and getattr(c, 'text', None):
                parts.append(c.text)
    return ''.join(parts)


def json_schema(name: str, schema: dict) -> dict:
    """
    Wrap a JSON schema for the Responses API. Strict mode requires every
    property in `required` and additionalProperties false, so assert that here
    rather than let the API reject it later.
    """
    _assert_strict(schema, name)
    return {'type': 'json_schema', 'name': name, 'schema': schema, 'strict': True}


def _assert_strict(node, where: str) -> None:
    if not isinstance(node, dict):
        return
    if node.get('type') == 'object':
        if node.get('additionalProperties') is not False:
            raise ValueError(f'schema {where}: every object needs additionalProperties:false for strict mode')
        props = list((node.get('properties') or {}).keys())
        missing = [p for p in props if p not in (node.get('required') or [])]
        if missing:
            raise ValueError(f"schema {where}: strict mode requires every property in 'required' — missing {', '.join(missing)}")
        for k, v in (node.get('properties') or {}).items():
            _assert_strict(v, f'{where}.{k}')
    if node.get('type') == 'array':
        _assert_strict(node.get('items'), f'{where}[]')


def short_error(err) -> str:
    status = getattr(err, 'status_code', None) or getattr(err, 'status', None)
    if isinstance(status, int):
        return f'HTTP {status}'
    m = str(err)
    return f'{m[:80]}…' if len(m) > 80 else m


def summarise(value):
    """Keep base64 blobs and huge strings out of the trace table."""
    if isinstance(value, str):
        if value.startswith('data:'):
            return f'{value[:40]}…[{len(value)} bytes]'
        return value if len(value) <= 4000 else f'{value[:4000]}…'
    if isinstance(value, dict):
        return {k: summarise(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [summarise(v) for v in value]
    return value


def call_model(*, route: str, input, system: str | None = None, format: dict | None = None,
               effort: str = 'medium', verbosity: str = 'low', tools: list | None = None,
               user_id=None, model: str | None = None, max_output: int = 8000,
               guardrail: dict | None = None, timeout_s: float = 120) -> dict:
    """Run one model call and trace it. Returns {data, traceId, degraded[, degradedNote]}."""
    model = model or MODELS['reason']
    started = time.time()
    request = {'model': model, 'input': input}
    if system:
        request['instructions'] = system
    request['text'] = {'format': format, 'verbosity': verbosity} if format else {'verbosity': verbosity}
    if tools:
        request['tools'] = tools
    request['reasoning'] = {'effort': effort}
    request['max_output_tokens'] = max_output
    key = cache_key(route, user_id, {'model': model, 'input': input, 'system': system,
                                     'format': format['name'] if format else None})

    try:
        response = client().responses.create(**request, timeout=timeout_s)
        if response.status == 'incomplete':
            # Reasoning tokens count against max_output_tokens on GPT-5; say so
            # plainly rather than failing later on half a JSON document.
            why = _field(response.incomplete_details, 'reason') or 'unknown'
            raise RuntimeError(f'{route}: response incomplete ({why}) — raise max_output or lower effort')
        text = _output_text(response)

        data = text
        if format:
            try:
                data = json.loads(text)
            except ValueError as err:
                raise RuntimeError(f'model returned unparseable JSON for {route}: {text[:300]}') from err

        tool_calls = [o.model_dump() for o in (response.output or []) if getattr(o, 'type', None) == 'function_call']
        confidence = data.get('confidence') if isinstance(data, dict) else None
        trace_id = insert('traces', {
            'user_id': user_id, 'route': route, 'model': model, 'effort': effort,
            'input_json': to_json({'system': system, 'input': summarise(input)}),
            'output_json': to_json(data)[:20000],
            'tool_calls_json': to_json(tool_calls) if tool_calls else None,
            'latency_ms': int((time.time() - started) * 1000),
            'input_tokens': _field(response.usage, 'input_tokens'),
            'output_tokens': _field(response.usage, 'output_tokens'),
            'cost_usd': _cost(model, response.usage),
            'confidence': confidence if isinstance(confidence, (int, float)) and not isinstance(confidence, bool) else None,
            'guardrail_json': to_json(guardrail) if guardrail else None,
            'status': 'ok',
        })
        _write_cache(key, data)
        return {'data': data, 'traceId': trace_id, 'degraded': False}
    except Exception as err:
        cached = _read_cache().get(key)
        trace_id = insert('traces', {
            'user_id': user_id, 'route': route, 'model': model, 'effort': effort,
            'input_json': to_json({'system': system, 'input': summarise(input)}),
            'output_json': to_json(cached['payload'])[:20000] if cached else None,
            'latency_ms': int((time.time() - started) * 1000),
            'status': 'degraded' if cached else 'error',
            'error': str(err)[:500],
        })
        if cached:
            return {
                'data': cached['payload'], 'traceId': trace_id, 'degraded': True,
                'degradedNote': f"Live call failed ({short_error(err)}). Replayed the response to this identical request, recorded {cached['at']}.",
            }
        err.trace_id = trace_id
        raise


def record_trace(*, route: str, user_id, started_at: float, model: str | None = None, effort: str | None = None,
                 input=None, output=None, tool_calls=None, usage=None, status: str = 'ok', error: str | None = None) -> int:
    """Trace a call made outside call_model — the assistant streams, so it drives the client itself."""
    model = model or MODELS['reason']
    return insert('traces', {
        'user_id': user_id, 'route': route, 'model': model, 'effort': effort,
        'input_json': to_json(summarise(input)),
        'output_json': None if output is None else to_json(output)[:20000],
        'tool_calls_json': to_json(tool_calls) if tool_calls else None,
        'latency_ms': int((time.time() - started_at) * 1000),
        'input_tokens': _field(usage, 'input_tokens'),
        'output_tokens': _field(usage, 'output_tokens'),
        'cost_usd': _cost(model, usage),
        'status': status, 'error': error,
    })


def transcribe(buffer: bytes, filename: str = 'note.webm', user_id=None, seconds=None) -> dict:
    """Transcribe an audio buffer with Whisper."""
    started = time.time()
    key = cache_key('voice.transcribe', user_id, hashlib.sha1(buffer).hexdigest())
    try:
        result = client().audio.transcriptions.create(file=(filename, buffer), model=MODELS['transcribe'], language='en')
        text = getattr(result, 'text', '') or ''
        trace_id = insert('traces', {
            'user_id': user_id, 'route': 'voice.transcribe', 'model': MODELS['transcribe'],
            'input_json': to_json({'filename': filename, 'bytes': len(buffer), 'seconds': seconds}),
            'output_json': to_json({'text': text}),
            'latency_ms': int((time.time() - started) * 1000),
            'cost_usd': float(f'{(seconds / 60) * WHISPER_PER_MINUTE:.6f}') if seconds else None,
            'status': 'ok',
        })
        _write_cache(key, {'text': text})
        return {'text': text, 'traceId': trace_id, 'degraded': False}
    except Exception as err:
        cached = _read_cache().get(key)
        trace_id = insert('traces', {
            'user_id': user_id, 'route': 'voice.transcribe', 'model': MODELS['transcribe'],
            'latency_ms': int((time.time() - started) * 1000),
            'status': 'degraded' if cached else 'error',
            'error': str(err)[:500],
        })
        if cached:
            return {'text': cached['payload']['text'], 'traceId': trace_id, 'degraded': True,
                    'degradedNote': f'Transcription failed ({short_error(err)}). Replayed the transcript of this identical recording.'}
        err.trace_id = trace_id
        raise
