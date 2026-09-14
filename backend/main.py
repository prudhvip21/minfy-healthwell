"""
HealthWise Platform 2.0 — FastAPI service.

Same routes and JSON shapes as the original Express API, so the React UI works
against it unchanged. Endpoints are plain functions: the slow part of nearly
every request is a model call, and FastAPI runs sync endpoints in a thread pool.

Run:  uv run uvicorn backend.main:app --port 4000
"""

import base64
import functools
import math
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

from fastapi import Body, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from .agents.assistant import chat
from .agents.insights import explain_entry, funnel, narrate_score, score_history
from .agents.logging_agent import extract_and_log, log_selection
from .agents.planswap import decide, propose_adjustment, review_queue
from .agents.reward import generate_reward, streak_target
from .agents.trigger import TONE_BANDS, detect_signals, generate_nudges, list_nudges, mark_nudge
from .db import ROOT, all_rows, from_json, get_row, run, to_json
from .engine import (SLOTS, active_plan, add_days, behaviour_score, day_entries, day_totals,
                     days_since_last_checkin, streak, today)
from .llm import MODELS, has_key, transcribe
from .plan_import import import_plans, list_plan_files, needs_bootstrap
from .reset import reset_demo
from .util import js_number

PORT = int(os.environ.get('PORT') or 4000)
NO_KEY_HINT = 'OPENAI_API_KEY is not set — add it to .env and restart.'


# ------------------------------------------------------------------ boot

def _history_stale() -> bool:
    """True when seeded history is missing or older than yesterday: the demo sat overnight, or a reset was interrupted."""
    if not get_row('SELECT COUNT(*) AS n FROM users')['n']:
        return False
    row = get_row('SELECT MAX(date) AS d FROM checkins')
    return not (row and row['d']) or row['d'] < add_days(today(), -1)


def boot() -> None:
    if needs_bootstrap():
        print('Empty database — bootstrapping users, plans and history …', flush=True)
        import_plans()
    elif _history_stale():
        # Seeded history is relative to "today"; left overnight the personas drift
        # (a 20-day streak reads as 0). Parsed plans are kept, so this is free.
        print('Seeded history is from a previous day — refreshing demo state …', flush=True)
        reset_demo(log=lambda _line: None)
    elif has_key() and list_plan_files() and all_rows("SELECT id FROM plans WHERE parse_status != 'parsed'"):
        print('OPENAI_API_KEY found and some users are on fallback plans — parsing plan documents …', flush=True)
        import_plans()
    key_state = 'set' if has_key() else 'MISSING — add OPENAI_API_KEY to .env'
    print(f'HealthWise API on http://localhost:{PORT}  (key: {key_state})', flush=True)


@asynccontextmanager
async def lifespan(_app):
    boot()
    yield


app = FastAPI(title='HealthWise Platform 2.0', lifespan=lifespan)


# ----------------------------------------------------------------------------
# API layer: partner scoping and rate limits.
#
# Every request may carry x-partner-id. The partner's configuration decides
# which use cases it can reach and how often — the same services, exposed as a
# configured subset. No header means first party.
# ----------------------------------------------------------------------------

USE_CASE_BY_PREFIX = [
    ('/api/checkin', 'checkin'), ('/api/transcribe', 'checkin'),
    ('/api/plan/propose', 'planloop'), ('/api/review', 'planloop'),
    ('/api/nudges', 'nudges'), ('/api/assistant', 'assistant'),
    ('/api/score', 'score'), ('/api/explain', 'explain'),
]

_hits: dict = {}
_hits_lock = threading.Lock()


@app.middleware('http')
async def partner_scope(request: Request, call_next):
    partner_id = request.headers.get('x-partner-id')
    path = request.url.path
    if not partner_id or not path.startswith('/api'):
        return await call_next(request)

    partner = get_row('SELECT * FROM partners WHERE id = ?', partner_id)
    if not partner:
        return JSONResponse({'error': f'Unknown partner "{partner_id}".'}, status_code=401)

    use_case = next((uc for prefix, uc in USE_CASE_BY_PREFIX if path.startswith(prefix)), None)
    enabled = from_json(partner['enabled_json'], [])
    if use_case and use_case not in enabled:
        return JSONResponse({'error': f'"{use_case}" is not enabled for {partner["name"]}.',
                             'partner': partner['id'], 'enabled': enabled}, status_code=403)

    now = time.time() * 1000
    with _hits_lock:
        hit = _hits.get(partner_id) or {'windowStart': now, 'count': 0}
        if now - hit['windowStart'] > 60_000:
            hit = {'windowStart': now, 'count': 0}
        hit['count'] += 1
        _hits[partner_id] = hit
        count = hit['count']

    limit = partner['rate_limit']
    headers = {'x-ratelimit-limit': str(limit), 'x-ratelimit-remaining': str(max(0, limit - count))}
    if count > limit:
        return JSONResponse({'error': f'Rate limit of {limit}/min reached for {partner["name"]}.'},
                            status_code=429, headers=headers)

    response = await call_next(request)
    response.headers.update(headers)
    return response


# ------------------------------------------------------------------ helpers

def _error_response(err: Exception, where: str) -> JSONResponse:
    status = getattr(err, 'status_code', None)
    status = status if isinstance(status, int) and status < 600 else 500
    payload = {'error': str(err) or type(err).__name__, 'traceId': getattr(err, 'trace_id', None)}
    if not has_key():
        payload['hint'] = NO_KEY_HINT
    print(f'[{where}] {err}', flush=True)
    return JSONResponse(payload, status_code=status)


def guarded(fn):
    """A thrown error becomes a JSON error carrying its trace id, as the original service's handlers did."""
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception as err:  # noqa: BLE001
            return _error_response(err, fn.__name__)
    return wrapper


@app.exception_handler(Exception)
async def _unhandled(request: Request, err: Exception):
    return _error_response(err, f'{request.method} {request.url.path}')


def _body(body) -> dict:
    return body if isinstance(body, dict) else {}


def _find_user(user_id):
    return get_row('SELECT * FROM users WHERE id = ?', user_id) if user_id else None


def _no_user(user_id) -> JSONResponse:
    return JSONResponse({'error': f'No such user "{"undefined" if user_id is None else user_id}".'}, status_code=404)


def _public_user(u: dict) -> dict:
    return {**u, 'conditions': from_json(u['conditions_json'], []), 'allergies': from_json(u['allergies_json'], [])}


def _finite_int(v):
    n = js_number(v)
    return int(n) if math.isfinite(n) else None


# ------------------------------------------------------------------- system

@app.get('/api/health')
def health():
    return {
        'ok': True, 'hasKey': has_key(), 'models': MODELS, 'today': today(),
        'planFiles': list_plan_files(),
        'plans': all_rows('SELECT user_id, source_file, parse_status, parse_note, duration_days FROM plans'),
    }


@app.post('/api/reset')
@guarded
def reset(body: dict | None = Body(default=None)):
    lines: list = []
    report = reset_demo(reparse=bool(_body(body).get('reparse')), log=lines.append)
    return {'report': report, 'log': lines}


@app.post('/api/import')
@guarded
def import_route(body: dict | None = Body(default=None)):
    lines: list = []
    report = import_plans(force=bool(_body(body).get('force')), log=lines.append)
    return {'report': report, 'log': lines}


# -------------------------------------------------------------------- users

@app.get('/api/users')
def users():
    out = []
    for u in all_rows('SELECT * FROM users ORDER BY rowid'):
        s = behaviour_score(u['id'])
        out.append({
            **_public_user(u),
            'score': s['score'], 'band': s['band'],
            'streak': streak(u['id']), 'silent': days_since_last_checkin(u['id']),
            'pendingReviews': get_row("SELECT COUNT(*) AS n FROM plan_changes WHERE user_id = ? AND status = 'pending'", u['id'])['n'],
        })
    return out


# --------------------------------------------------------------------- plan

@app.get('/api/plan/{user_id}')
def plan_for_day(user_id: str, date: str | None = None):
    user = _find_user(user_id)
    if not user:
        return _no_user(user_id)
    d = date or today()
    plan = active_plan(user['id'])
    entries = day_entries(user['id'], d)
    slots = [{'slot': s, 'items': [e for e in entries if e['slot'] == s]} for s in SLOTS]

    return {
        'date': d,
        'user': _public_user(user),
        'plan': {
            'id': plan['id'], 'source_file': plan['source_file'], 'parse_status': plan['parse_status'],
            'parse_note': plan['parse_note'], 'cycle_days': plan['duration_days'],
            'targets': from_json(plan['targets_json'], {}), 'guidance': from_json(plan['guidance_json'], []),
        } if plan else None,
        'totals': day_totals(user['id'], d),
        'slots': [g for g in slots if g['items']],
        'streak': streak_target(user['id']),
    }


# ----------------------------------------------------------------- check-in

@app.post('/api/transcribe')
@guarded
def transcribe_route(body: dict | None = Body(default=None)):
    b = _body(body)
    user = _find_user(b.get('userId'))
    if not user:
        return _no_user(b.get('userId'))
    audio = b.get('audioBase64')
    if not audio:
        return JSONResponse({'error': 'audioBase64 is required'}, status_code=400)
    mime = b.get('mime') or 'audio/webm'
    ext = 'mp4' if 'mp4' in mime else 'ogg' if 'ogg' in mime else 'wav' if 'wav' in mime else 'webm'
    return transcribe(base64.b64decode(audio), filename=f'note.{ext}', user_id=user['id'], seconds=b.get('seconds'))


def _safely(fn):
    try:
        return fn()
    except Exception as err:  # noqa: BLE001 — reward and adjustment failures must not sink the check-in
        return {'error': str(err)}


@app.post('/api/checkin')
@guarded
def checkin(body: dict | None = Body(default=None)):
    """
    The full check-in loop in one request: (transcribe) -> logging agent -> engine
    match -> guardrails -> reward, and, if anything was off-plan, the plan-swap
    agent -> engine gate.
    """
    b = _body(body)
    user = _find_user(b.get('userId'))
    if not user:
        return _no_user(b.get('userId'))

    modality = b.get('modality', 'text')
    image = b.get('imageDataUrl')
    audio = b.get('audioBase64')
    text = b.get('text', '')

    transcript = None
    if modality == 'voice' and audio:
        ext = 'mp4' if 'mp4' in str(b.get('mime') or '') else 'webm'
        transcript = transcribe(base64.b64decode(audio), filename=f'note.{ext}', user_id=user['id'], seconds=b.get('seconds'))
        text = transcript['text']

    if not text and not image:
        return JSONResponse({'error': 'Send text, a photo, or a voice note.'}, status_code=400)

    logged = extract_and_log(user, modality, text=text, image_data_url=image, slot=b.get('slot') or None)

    # Reward and plan adjustment are independent — run them together.
    with ThreadPoolExecutor(max_workers=2) as pool:
        reward_job = pool.submit(_safely, lambda: generate_reward(user, logged)) if b.get('reward', True) else None
        adjust_job = (pool.submit(_safely, lambda: propose_adjustment(user, unplanned=logged['unplanned'], trigger='checkin'))
                      if b.get('autoAdjust', True) and logged['unplanned'] else None)
        reward = reward_job.result() if reward_job else None
        adjustment = adjust_job.result() if adjust_job else None

    return {'transcript': transcript, 'logged': logged, 'reward': reward, 'adjustment': adjustment,
            'plan': day_totals(user['id'], today())}


@app.post('/api/checkin/select')
@guarded
def checkin_select(body: dict | None = Body(default=None)):
    """Menu-style check-in: tick items off the plan, plus optional free-text extras."""
    b = _body(body)
    user = _find_user(b.get('userId'))
    if not user:
        return _no_user(b.get('userId'))

    ids = [i for i in (_finite_int(x) for x in b.get('entryIds') or []) if i is not None]
    logged = log_selection(user, b.get('slot'), entry_ids=ids, extras=b.get('extras') or '')
    if not logged['items']:
        return JSONResponse({'error': 'Nothing selected.'}, status_code=400)

    reward = _safely(lambda: generate_reward(user, logged)) if b.get('reward', True) else None
    return {'transcript': None, 'logged': logged, 'reward': reward, 'adjustment': None,
            'plan': day_totals(user['id'], today())}


# ---------------------------------------------------------------- plan loop

@app.post('/api/plan/readjust')
@guarded
def plan_readjust(body: dict | None = Body(default=None)):
    """Readjust the day from what actually happened — no meal input needed."""
    b = _body(body)
    user = _find_user(b.get('userId'))
    if not user:
        return _no_user(b.get('userId'))
    return propose_adjustment(user, date=b.get('date') or today(), trigger='readjust')


@app.post('/api/plan/propose')
@guarded
def plan_propose(body: dict | None = Body(default=None)):
    b = _body(body)
    user = _find_user(b.get('userId'))
    if not user:
        return _no_user(b.get('userId'))
    return propose_adjustment(user, unplanned=b.get('unplanned') or [], trigger=b.get('trigger') or 'manual')


@app.get('/api/review')
def review(userId: str | None = None):
    return review_queue(userId or None)


@app.post('/api/review/{change_id}/decide')
@guarded
def review_decide(change_id: str, body: dict | None = Body(default=None)):
    b = _body(body)
    decision = b.get('decision')
    if decision not in ('approved', 'rejected'):
        return JSONResponse({'error': 'decision must be "approved" or "rejected"'}, status_code=400)
    return decide(_finite_int(change_id), decision, b.get('reviewer'))


# ------------------------------------------------------------------- nudges

def _parse_override(v):
    if v is None or v == '':
        return None
    n = js_number(v)
    return None if math.isnan(n) else max(0.0, min(1.0, n))


@app.get('/api/nudges/{user_id}')
def nudges(user_id: str, adherence: str | None = None):
    user = _find_user(user_id)
    if not user:
        return _no_user(user_id)
    return {
        'signals': detect_signals(user, adherence_override=_parse_override(adherence)),
        'nudges': list_nudges(user['id']),
        'bands': [{'key': b['key'], 'label': b['label'], 'range': b['range'], 'escalate': bool(b.get('escalate'))}
                  for b in TONE_BANDS],
    }


@app.post('/api/nudges/{user_id}/generate')
@guarded
def nudges_generate(user_id: str, body: dict | None = Body(default=None)):
    user = _find_user(user_id)
    if not user:
        return _no_user(user_id)
    b = _body(body)
    return generate_nudges(user, count=b.get('count') or 3, adherence_override=_parse_override(b.get('adherence')))


@app.post('/api/nudges/item/{nudge_id}/status')
@guarded
def nudge_status(nudge_id: str, body: dict | None = Body(default=None)):
    status = _body(body).get('status')
    if status not in ('sent', 'opened', 'ignored', 'queued', 'escalated'):
        return JSONResponse({'error': 'bad status'}, status_code=400)
    return mark_nudge(_finite_int(nudge_id), status)


# -------------------------------------------------------------------- score

@app.get('/api/score/{user_id}')
def score(user_id: str):
    user = _find_user(user_id)
    if not user:
        return _no_user(user_id)
    return {**behaviour_score(user['id']), 'history': score_history(user['id']), 'streak': streak_target(user['id'])}


@app.post('/api/score/{user_id}/narrate')
@guarded
def score_narrate(user_id: str):
    user = _find_user(user_id)
    if not user:
        return _no_user(user_id)
    return narrate_score(user)


@app.get('/api/funnel')
def funnel_route():
    return funnel()


# ------------------------------------------------------------------ explain

@app.post('/api/explain/{user_id}')
@guarded
def explain(user_id: str, body: dict | None = Body(default=None)):
    user = _find_user(user_id)
    if not user:
        return _no_user(user_id)
    b = _body(body)
    question = b.get('question')
    return explain_entry(user, b.get('entryIds') or [], question=str('' if question is None else question)[:500])


# ---------------------------------------------------------------- assistant

@app.post('/api/assistant')
def assistant(body: dict | None = Body(default=None)):
    b = _body(body)
    user = _find_user(b.get('userId'))
    if not user:
        return _no_user(b.get('userId'))

    def events():
        try:
            for event, data in chat(user, str(b.get('message') or ''), b.get('previousResponseId') or None):
                yield f'event: {event}\ndata: {to_json(data)}\n\n'
        except Exception as err:  # noqa: BLE001
            yield f"event: error\ndata: {to_json({'message': str(err)})}\n\n"

    return StreamingResponse(events(), media_type='text/event-stream',
                             headers={'Cache-Control': 'no-cache', 'Connection': 'keep-alive'})


# ------------------------------------------------------------------- traces

def _trace_out(t: dict) -> dict:
    return {**t, 'input': from_json(t['input_json'], None), 'output': from_json(t['output_json'], None),
            'toolCalls': from_json(t['tool_calls_json'], None), 'guardrail': from_json(t['guardrail_json'], None)}


@app.get('/api/traces')
def traces(limit: str | None = None, userId: str | None = None):
    requested = _finite_int(limit)
    lim = min(requested or 100, 500)
    if userId:
        rows = all_rows('SELECT * FROM traces WHERE user_id = ? ORDER BY id DESC LIMIT ?', userId, lim)
    else:
        rows = all_rows('SELECT * FROM traces ORDER BY id DESC LIMIT ?', lim)
    totals = get_row("""SELECT COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                               SUM(cost_usd) AS cost_usd, AVG(latency_ms) AS avg_latency,
                               SUM(status = 'degraded') AS degraded, SUM(status = 'error') AS errors
                          FROM traces""")
    return {'totals': totals, 'traces': [_trace_out(t) for t in rows]}


@app.get('/api/traces/{trace_id}')
def trace(trace_id: str):
    tid = _finite_int(trace_id)
    t = get_row('SELECT * FROM traces WHERE id = ?', tid) if tid is not None else None
    if not t:
        return JSONResponse({'error': 'no such trace'}, status_code=404)
    return _trace_out(t)


# ----------------------------------------------------------------- partners

@app.get('/api/partners')
def partners():
    return [{**p, 'brand': from_json(p['brand_json'], {}), 'enabled': from_json(p['enabled_json'], []),
             'active': bool(p['active'])} for p in all_rows('SELECT * FROM partners')]


@app.put('/api/partners/{partner_id}')
def partner_update(partner_id: str, body: dict | None = Body(default=None)):
    p = get_row('SELECT * FROM partners WHERE id = ?', partner_id)
    if not p:
        return JSONResponse({'error': 'no such partner'}, status_code=404)
    b = _body(body)
    if b.get('enabled') is not None:
        run('UPDATE partners SET enabled_json = ? WHERE id = ?', to_json(b['enabled']), p['id'])
    if b.get('rate_limit'):
        n = js_number(b['rate_limit'])
        run('UPDATE partners SET rate_limit = ? WHERE id = ?', int(n) if n.is_integer() else n, p['id'])
    if b.get('brand') is not None:
        run('UPDATE partners SET brand_json = ? WHERE id = ?', to_json(b['brand']), p['id'])
    with _hits_lock:
        _hits.pop(p['id'], None)
    return {'ok': True}


# ------------------------------------------------------------- static build

_DIST = ROOT / 'dist'
if _DIST.exists():
    @app.get('/{full_path:path}', include_in_schema=False)
    def spa(full_path: str):
        if full_path.startswith('api'):
            return JSONResponse({'error': 'Not found'}, status_code=404)
        target = (_DIST / full_path).resolve()
        inside = _DIST.resolve() in target.parents
        return FileResponse(target if full_path and inside and target.is_file() else _DIST / 'index.html')
