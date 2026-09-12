import { useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  Card, Spinner, Degraded, ErrorBox, Verdict, TraceStrip, PlanBoard, Macros, Flow, Confidence, shortFlag,
} from '../components.jsx';

export default function PlanLoop({ user, onChange, go }) {
  const [plan, setPlan] = useState(null);
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const load = () => {
    api.get(`/api/plan/${user.id}`).then(setPlan).catch(setError);
    api.get(`/api/review?userId=${user.id}`).then((rows) => setHistory(rows.filter((r) => r.kind === 'swap'))).catch(() => {});
  };
  useEffect(load, [user.id]);

  async function readjust() {
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await api.post('/api/plan/readjust', { userId: user.id });
      setResult(r);
      load();
      onChange?.();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  const items = (plan?.slots || []).flatMap((s) => s.items);
  const eaten = items.filter((i) => i.status === 'eaten');
  const offPlan = items.filter((i) => i.status === 'offplan');
  const left = items.filter((i) => i.status === 'planned' || i.status === 'added');
  const t = plan?.totals;
  const over = t ? t.consumed.kcal - t.planned.kcal : 0;

  const engine = result && {
    delta: result.validation.delta, kcalDriftPct: result.validation.kcalDriftPct, reasons: result.validation.reasons,
    removals: result.validation.removals, additions: result.validation.additions,
    moves: result.validation.moves, conflicts: result.validation.conflicts,
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Readjust Plan</h1></div>
      </div>

      <div className="split phone-left">
        <div>
          <div className="phone screen">
            <div className="phone-top">
              <small>{plan?.date}</small>
              <h2>{result ? 'Your day, rebalanced' : 'Rebalance my day'}</h2>
            </div>

            <div className="phone-body stack">
              {!result ? (
                <>
                  <div className="day-stats">
                    <div><b>{eaten.length}</b><span>eaten</span></div>
                    <div><b style={{ color: offPlan.length ? '#c2491a' : undefined }}>{offPlan.length}</b><span>off-plan</span></div>
                    <div><b>{left.length}</b><span>still to come</span></div>
                  </div>

                  {t && (
                    <div className="stack" style={{ gap: 6 }}>
                      <Macros totals={t} />
                      {over > 0 && <div className="banner amber small"><span>⚖</span><div>{Math.round(over)} kcal over the day's plan.</div></div>}
                    </div>
                  )}

                  {offPlan.length > 0 && (
                    <div className="stack" style={{ gap: 4 }}>
                      <div className="tiny strong muted">OFF-PLAN TODAY</div>
                      {offPlan.map((i) => (
                        <div key={i.id} className="small" style={{ color: i.flag ? 'var(--red)' : '#c2491a' }}>
                          {i.flag ? '⚠' : '＋'} {i.name} <span className="muted">· {i.slot} · {Math.round(i.kcal)} kcal{i.flag ? ` · ${shortFlag(i.flag)}` : ''}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <p className="small muted">
                    The agent reads what you have eaten and what went off-plan, then proposes the smallest
                    change to the rest of your day — moving untouched dishes to a later day where they still fit.
                  </p>

                  <button className="btn primary" onClick={readjust} disabled={busy || (!left.length && !offPlan.length)}>
                    {busy ? <><Spinner /> Rebalancing…</> : 'Readjust my plan'}
                  </button>
                  <ErrorBox error={error} />
                </>
              ) : (
                <Outcome result={result} onAgain={() => setResult(null)} go={go} />
              )}
            </div>
          </div>
        </div>

        <div className="stack">
          <Card title={`Today · ${plan?.date || ''}`}>
            <PlanBoard slots={plan?.slots || []} />
          </Card>

          {busy && <Card title="Swap agent"><div className="row small"><Spinner /> Reading the day and proposing…</div></Card>}

          {result && (
            <>
              <Degraded note={result.degradedNote} />
              <Card title="Proposal" actions={result.decision === 'pending' && <button className="btn sm" onClick={() => go('review')}>Dietitian queue →</button>}>
                <EngineView change={{ ...result, engine }} />
                {result.dietitianSummary && (
                  <div className="banner blue small" style={{ marginTop: 12 }}>
                    <span>🩺</span><div><b>For the dietitian:</b> {result.dietitianSummary}</div>
                  </div>
                )}
                <div style={{ marginTop: 14 }}><TraceStrip ids={[result.traceId]} /></div>
              </Card>
            </>
          )}

          <Card title="Authority">
            <Flow nodes={[
              { label: "Today's log", kind: 'rule' },
              { label: 'Swap agent proposes', kind: 'ai' },
              { label: 'engine.validateSwap', kind: 'rule' },
              { label: 'engine.gate', kind: 'rule' },
              { label: 'auto-apply ≥85%', kind: 'rule' },
              { label: 'or dietitian', kind: 'human' },
            ]} />
          </Card>

          <Card title="History" hint={`${history.length}`} pad={false}>
            {history.length ? (
              <table className="t">
                <thead><tr><th>Change</th><th>Conf.</th><th>Outcome</th></tr></thead>
                <tbody>
                  {history.map((hh) => (
                    <tr key={hh.id}>
                      <td>{hh.summary}</td>
                      <td><Confidence value={hh.confidence} /></td>
                      <td><Verdict verdict={hh.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="empty">No proposals yet.</div>}
          </Card>
        </div>
      </div>
    </>
  );
}

function Outcome({ result, onAgain, go }) {
  const v = result.validation;
  let mark = 'done-mark'; let title;
  if (result.decision === 'auto_applied') { title = 'Plan updated'; }
  else if (result.decision === 'pending') { mark += ' amber'; title = 'Sent to your dietitian'; }
  else { mark += ' red'; title = 'No change made'; }

  return (
    <div className="stack center" style={{ gap: 12 }}>
      <div className={mark}>{mark.includes('amber') ? '🩺' : mark.includes('red') ? '✕' : '✓'}</div>
      <div>
        <h2>{title}</h2>
        <div className="small" style={{ marginTop: 4 }}>{result.userMessage}</div>
      </div>

      <div className="stack small" style={{ gap: 4, textAlign: 'left', width: '100%' }}>
        {v.moves.map((m) => (
          <div key={m.entry.id}>↪ <b>{m.entry.name}</b> <span className="muted">moved to {m.to}</span></div>
        ))}
        {v.removals.map((r) => (
          <div key={r.id} className="muted"><span style={{ textDecoration: 'line-through' }}>{r.name}</span> · dropped</div>
        ))}
        {v.additions.map((a, i) => (
          <div key={i} style={{ color: 'var(--blue)' }}>＋ {a.name} <span className="muted">· {a.slot}</span></div>
        ))}
        {!v.moves.length && !v.removals.length && !v.additions.length && <div className="muted">No changes needed.</div>}
      </div>

      <div className="row" style={{ justifyContent: 'center' }}>
        <button className="btn" onClick={onAgain}>Back</button>
        {result.decision === 'pending' && <button className="btn ghost" onClick={() => go('review')}>Dietitian queue →</button>}
      </div>
    </div>
  );
}

/** The engine's verdict on a proposal. Shared with the dietitian queue. */
export function EngineView({ change }) {
  const e = change.engine || {};
  const p = change.proposal || {};
  const high = (e.conflicts || []).filter((c) => c.severity === 'high');
  const moves = e.moves || [];
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row wrap">
        <Verdict verdict={change.decision || change.status} />
        <Confidence value={change.confidence} />
        {e.delta && <span className="chip mono">Δ {e.delta.kcal > 0 ? '+' : ''}{e.delta.kcal} kcal</span>}
        {e.kcalDriftPct != null && <span className={`chip ${e.kcalDriftPct > 0.15 ? 'amber' : ''}`}>{Math.round(e.kcalDriftPct * 100)}% of day</span>}
      </div>
      {(change.rationale || p.rationale) && <div className="small muted">{change.rationale || p.rationale}</div>}

      <div className="grid-3" style={{ gap: 12 }}>
        <div>
          <div className="tiny strong muted">MOVED</div>
          {moves.length ? moves.map((m, i) => (
            <div key={i} className="small">{m.name || m.entry?.name} <span className="muted">→ {m.to}</span></div>
          )) : <div className="small muted">—</div>}
        </div>
        <div>
          <div className="tiny strong muted">DROPPED</div>
          {(e.removals || []).length ? e.removals.map((r) => (
            <div key={r.id} className="small" style={{ textDecoration: 'line-through' }}>{r.name} <span className="muted">{Math.round(r.kcal)} kcal</span></div>
          )) : <div className="small muted">—</div>}
        </div>
        <div>
          <div className="tiny strong muted">ADDED</div>
          {(e.additions || []).length ? e.additions.map((a, i) => (
            <div key={i} className="small">{a.name} <span className="muted">{a.qty} {a.unit} · {a.slot}</span></div>
          )) : <div className="small muted">—</div>}
        </div>
      </div>

      {(e.reasons || []).length > 0 && (
        <div className="banner amber small"><span>⚖</span><div>{e.reasons.map((r, i) => <div key={i}>{r}</div>)}</div></div>
      )}
      {high.length > 0 && (
        <div className="banner red small"><span>⛔</span><div>{high.map((c, i) => <div key={i}>{c.reason}</div>)}</div></div>
      )}
    </div>
  );
}
