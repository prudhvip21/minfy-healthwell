import { useEffect, useState } from 'react';
import { api } from './api.js';

export function Card({ title, hint, icon, children, pad = true, className = '', actions }) {
  return (
    <div className={`card ${className}`}>
      {title && (
        <div className="card-head">
          {icon && <span>{icon}</span>}
          <h2>{title}</h2>
          {hint && <span className="hint">{hint}</span>}
          {actions && <div style={{ marginLeft: hint ? 8 : 'auto' }} className="row">{actions}</div>}
        </div>
      )}
      <div className={pad ? 'card-body' : ''}>{children}</div>
    </div>
  );
}

export function Spinner() { return <span className="spin" />; }

export function Confidence({ value, label = true }) {
  if (value === null || value === undefined) return <span className="muted tiny">—</span>;
  const pct = Math.round(value * 100);
  const tone = value >= 0.85 ? '' : value >= 0.6 ? 'amber' : 'red';
  return (
    <span className="conf" title={`Model confidence ${pct}%`}>
      <span className={`bar ${tone}`}><i style={{ width: `${pct}%` }} /></span>
      {label && <span>{pct}%</span>}
    </span>
  );
}

export function Degraded({ note }) {
  if (!note) return null;
  return (
    <div className="banner amber">
      <span>⚠</span>
      <div><b>Served from cache — live call failed.</b> {note}</div>
    </div>
  );
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return (
    <div className="banner red">
      <span>✕</span>
      <div>
        <b>{error.message || String(error)}</b>
        {error.hint && <div className="small">{error.hint}</div>}
        {error.traceId && <div className="small">Trace #{error.traceId} recorded.</div>}
      </div>
    </div>
  );
}

export function Verdict({ verdict }) {
  const map = {
    matched: ['green', '✓ on plan'],
    unplanned: ['orange', '＋ off-plan'],
    flagged: ['red', '⚠ conflict · logged'],
    blocked: ['red', '⛔ blocked'],
    auto_applied: ['green', 'auto-applied'],
    pending: ['amber', 'dietitian review'],
    approved: ['green', 'approved'],
    rejected: ['red', 'rejected'],
    pass: ['green', 'pass'],
    review: ['amber', 'review'],
  };
  const [tone, label] = map[verdict] || ['', verdict];
  return <span className={`chip ${tone}`}>{label}</span>;
}

export function Stat({ k, v, d, tone }) {
  return (
    <div className="card stat">
      <div className="k">{k}</div>
      <div className="v" style={tone ? { color: `var(--${tone})` } : undefined}>{v}</div>
      {d && <div className="d">{d}</div>}
    </div>
  );
}

export function Bar({ value, tone }) {
  return <div className={`bar ${tone || ''}`}><i style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} /></div>;
}

/** A pipeline diagram: which hops were AI, which were rules, which were human. */
export function Flow({ nodes }) {
  return (
    <div className="flow">
      {nodes.map((n, i) => (
        <span key={i} className="row" style={{ gap: 6 }}>
          {i > 0 && <span className="arr">→</span>}
          <span className={`node ${n.kind || ''}`} title={n.title}>{n.label}</span>
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Trace strip — shows the model calls behind whatever just happened.
 * ------------------------------------------------------------------ */

export function TraceStrip({ ids = [], title = 'Agent calls' }) {
  const [traces, setTraces] = useState([]);
  const key = ids.filter(Boolean).join(',');

  useEffect(() => {
    const list = key ? key.split(',').map(Number) : [];
    if (!list.length) { setTraces([]); return; }
    Promise.all(list.map((id) => api.get(`/api/traces/${id}`).catch(() => null)))
      .then((rows) => setTraces(rows.filter(Boolean)));
  }, [key]);

  if (!traces.length) return null;
  const cost = traces.reduce((t, r) => t + (r.cost_usd || 0), 0);
  const ms = traces.reduce((t, r) => t + (r.latency_ms || 0), 0);

  return (
    <div>
      <div className="row small" style={{ marginBottom: 8 }}>
        <b>{title}</b>
        <span className="muted">
          {traces.length} call{traces.length > 1 ? 's' : ''} · {(ms / 1000).toFixed(1)}s · est. ${cost.toFixed(4)}
        </span>
      </div>
      {traces.map((t) => <TraceRow key={t.id} t={t} />)}
    </div>
  );
}

export function TraceRow({ t, showUser = false }) {
  const [open, setOpen] = useState(false);
  const g = t.guardrail;
  const gv = g?.output?.verdict || g?.input?.verdict;
  return (
    <div className="trace">
      <div className="trace-row" onClick={() => setOpen(!open)}>
        <span className={`status-dot ${t.status}`} title={t.status} />
        <span className="row" style={{ gap: 8, minWidth: 0 }}>
          <span className="route">{t.route}</span>
          {showUser && t.user_id && <span className="chip">{t.user_id}</span>}
          {t.status === 'degraded' && <span className="chip amber">degraded</span>}
          {t.status === 'error' && <span className="chip red">error</span>}
          {gv && gv !== 'pass' && <Verdict verdict={gv} />}
        </span>
        <span className="m">{t.model}{t.effort ? ` · ${t.effort}` : ''}</span>
        <span className="m">{t.latency_ms != null ? `${(t.latency_ms / 1000).toFixed(2)}s` : '—'}</span>
        <span className="m">{t.input_tokens != null ? `${t.input_tokens}→${t.output_tokens} tok` : '—'}</span>
        <span className="m">{t.cost_usd != null ? `$${t.cost_usd.toFixed(4)}` : '—'}</span>
      </div>
      {open && (
        <div className="trace-detail small">
          <div className="row wrap">
            <span className="muted">trace #{t.id}</span>
            <span className="muted">{t.ts}</span>
            {t.confidence != null && <span>confidence <Confidence value={t.confidence} /></span>}
          </div>
          {t.error && <div className="banner red" style={{ marginTop: 8 }}>{t.error}</div>}
          {t.toolCalls && (<><div className="strong" style={{ marginTop: 8 }}>Tool calls</div><pre>{JSON.stringify(t.toolCalls, null, 2)}</pre></>)}
          {g && (<><div className="strong" style={{ marginTop: 8 }}>Guardrails</div><pre>{JSON.stringify(g, null, 2)}</pre></>)}
          <div className="strong" style={{ marginTop: 8 }}>Input</div>
          <pre>{typeof t.input === 'string' ? t.input : JSON.stringify(t.input, null, 2)}</pre>
          <div className="strong" style={{ marginTop: 8 }}>Output</div>
          <pre>{typeof t.output === 'string' ? t.output : JSON.stringify(t.output, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Plan list — used by check-in, plan loop and explain.
 * ------------------------------------------------------------------ */

export function PlanList({ slots = [], justIds = [], onItem, selectedId }) {
  if (!slots.length) return <div className="empty">No plan for this date.</div>;
  return (
    <div>
      {slots.map((s) => (
        <div className="slot" key={s.slot}>
          <div className="slot-head">
            <b>{s.slot}</b>
            <span>{s.items[0]?.time_hint || ''}</span>
          </div>
          {s.items.map((e) => (
            <div
              key={e.id}
              className={`item ${e.status} ${e.flag ? 'flagged' : ''} ${justIds.includes(e.id) ? 'just' : ''}`}
              onClick={onItem ? () => onItem(e) : undefined}
              title={e.flag || (e.status === 'offplan' ? 'Eaten — not on the plan' : undefined)}
              style={{
                cursor: onItem ? 'pointer' : undefined,
                ...(selectedId === e.id ? { background: 'var(--green-soft)' } : {}),
              }}
            >
              <span className="tick">{e.status === 'eaten' ? '✓' : e.status === 'added' ? '+' : e.status === 'offplan' ? (e.flag ? '!' : '+') : ''}</span>
              <span className="name">
                {e.name}{' '}
                <span className="qty">{e.qty ?? ''} {e.unit || ''}</span>
                {e.status === 'added' && e.swapped_from && <span className="tiny muted"> · replaces {e.swapped_from}</span>}
                {e.status === 'offplan' && <span className="tiny"> · {e.flag ? shortFlag(e.flag) : 'not on plan'}</span>}
              </span>
              <span className="kcal" title={e.macro_source === 'estimated' ? 'Engine estimate — the plan document has no macros' : 'From the plan'}>
                {Math.round(e.kcal || 0)} kcal{e.macro_source === 'estimated' ? '*' : ''}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** "6:00AM" for one time, "6:00AM–7:00AM" when a slot spans several. */
function timeSpan(items) {
  const times = [...new Set(items.map((i) => i.time_hint).filter(Boolean))];
  if (!times.length) return '';
  return times.length === 1 ? times[0] : `${times[0]}–${times[times.length - 1]}`;
}

/**
 * The day as a timetable: meal cards laid out in rows rather than one long
 * strip, which is how a plan is actually read.
 */
export function PlanBoard({ slots = [], justIds = [], onItem, selectedId }) {
  if (!slots.length) return <div className="empty">No plan for this date.</div>;
  return (
    <div className="board">
      {slots.map((s) => (
        <div className="meal" key={s.slot}>
          <div className="meal-head">
            <b>{s.slot}</b>
            <span>{timeSpan(s.items)}</span>
          </div>
          {s.items.map((e) => (
            <div
              key={e.id}
              className={`li ${e.status} ${e.flag ? 'flagged' : ''} ${justIds.includes(e.id) ? 'just' : ''}`}
              onClick={onItem ? () => onItem(e) : undefined}
              title={e.flag || `${e.qty ?? ''} ${e.unit || ''} · ${Math.round(e.kcal || 0)} kcal${e.macro_source === 'estimated' ? ' (estimated)' : ''}`}
              style={{
                cursor: onItem ? 'pointer' : undefined,
                ...(selectedId === e.id ? { background: 'var(--green-soft)' } : {}),
              }}
            >
              <i />
              <span className="n">{e.name}</span>
              <span className="q">{e.qty ?? ''}{e.unit ? ` ${e.unit}` : ''}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** "Contains chicken, which the user's lacto-vegetarian diet excludes." → "not lacto-vegetarian" */
export function shortFlag(reason = '') {
  const allergy = /records an? (\w+) allergy/.exec(reason);
  if (allergy) return `${allergy[1]} allergy`;
  const diet = /user's ([\w-]+) diet/.exec(reason);
  if (diet) return `not ${diet[1]}`;
  return 'conflict';
}

/** Today's plan shaped for the slot bar: [{ slot, time, done, total }]. */
export function slotsFor(plan) {
  return (plan?.slots || []).map((s) => {
    const onPlan = s.items.filter((i) => i.status !== 'offplan' && i.status !== 'swapped');
    return {
      slot: s.slot,
      time: s.items.find((i) => i.time_hint)?.time_hint || null,
      total: onPlan.length,
      done: onPlan.filter((i) => i.status === 'eaten').length,
    };
  });
}

export function Macros({ totals }) {
  if (!totals) return null;
  const { planned, consumed } = totals;
  const rows = [
    ['Calories', consumed.kcal, planned.kcal, 'kcal'],
    ['Protein', consumed.protein_g, planned.protein_g, 'g'],
    ['Carbs', consumed.carbs_g, planned.carbs_g, 'g'],
    ['Fat', consumed.fat_g, planned.fat_g, 'g'],
  ];
  return (
    <div className="stack" style={{ gap: 9 }}>
      {rows.map(([k, c, p, u]) => (
        <div key={k}>
          <div className="row small">
            <span className="grow">{k}</span>
            <span className="mono">{Math.round(c)} / {Math.round(p)} {u}</span>
          </div>
          <Bar value={p ? c / p : 0} tone={p && c / p > 1.1 ? 'amber' : ''} />
        </div>
      ))}
      {totals.offPlanKcal > 0 && (
        <div className="tiny" style={{ color: '#c2491a' }}>incl. {Math.round(totals.offPlanKcal)} kcal off-plan</div>
      )}
      {totals.estimated && <div className="tiny muted">* estimated</div>}
    </div>
  );
}
