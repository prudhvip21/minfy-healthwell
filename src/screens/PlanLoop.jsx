import { useEffect, useState } from 'react';
import { api } from '../api.js';
import MealInput from '../MealInput.jsx';
import {
  Card, Lane, Spinner, Degraded, ErrorBox, Verdict, TraceStrip, PlanList, Macros, Flow, Confidence, slotsFor, shortFlag,
} from '../components.jsx';

const SAMPLES = ['Chicken biryani at a client lunch', '2 samosas with chai', 'Gulab jamun after dinner', 'Sweet lassi'];

export default function PlanLoop({ user, onChange, go }) {
  const [plan, setPlan] = useState(null);
  const [history, setHistory] = useState([]);
  const [stage, setStage] = useState('idle');     // idle | logging | proposing | done
  const [logged, setLogged] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [round, setRound] = useState(0);

  const load = () => {
    api.get(`/api/plan/${user.id}`).then(setPlan).catch(setError);
    api.get(`/api/review?userId=${user.id}`).then((rows) => setHistory(rows.filter((r) => r.kind === 'swap'))).catch(() => {});
  };
  useEffect(load, [user.id]);

  async function submit(payload) {
    setError(null); setResult(null); setLogged(null);
    setStage('logging');
    try {
      const r = await api.post('/api/checkin', { userId: user.id, ...payload, autoAdjust: false, reward: false });
      setLogged(r);
      load();                      // off-plan food shows on the day straight away
      if (!r.logged.unplanned.length) { setStage('done'); onChange?.(); return; }

      setStage('proposing');
      const p = await api.post('/api/plan/propose', {
        userId: user.id, trigger: 'user_request',
        unplanned: r.logged.unplanned.map((u) => ({ name: u.name, qty: u.qty, unit: u.unit, kcal: u.kcal })),
      });
      setResult(p);
      setStage('done');
      load();
      onChange?.();
    } catch (e) {
      setError(e);
      setStage('idle');
    }
  }

  function again() { setStage('idle'); setLogged(null); setResult(null); setError(null); setRound((n) => n + 1); }

  const engine = result && {
    delta: result.validation.delta, kcalDriftPct: result.validation.kcalDriftPct, reasons: result.validation.reasons,
    removals: result.validation.removals, additions: result.validation.additions, conflicts: result.validation.conflicts,
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Plan Change Loop</h1>
          <p className="sub">Off-plan meal → agent proposes → engine gates → auto-apply or dietitian.</p>
        </div>
      </div>

      <div className="split">
        <div className="stack">
          <Lane kind="user" />
          <div className="phone">
            <div className="phone-top">
              <small>Plan change</small>
              <h2>{stage === 'done' ? 'Done' : 'Ate something off-plan?'}</h2>
            </div>
            <div className="phone-body stack">
              {stage !== 'done' ? (
                <>
                  <MealInput key={round} onSubmit={submit} busy={stage !== 'idle'} samples={SAMPLES} slots={slotsFor(plan)}
                    submitLabel="Adjust my day" busyLabel={stage === 'proposing' ? 'Adjusting your day…' : 'Reading your meal…'} />
                  <ErrorBox error={error} />
                </>
              ) : (
                <Outcome logged={logged} result={result} onAgain={again} go={go} />
              )}
            </div>
          </div>

          <Card title={`Today · ${plan?.date || ''}`} hint="orange = off-plan · red = conflict · blue = added · struck = removed">
            <PlanList slots={plan?.slots || []} />
            <div style={{ marginTop: 14 }}><Macros totals={plan?.totals} /></div>
          </Card>
        </div>

        <div className="stack">
          <Lane kind="system" />
          <Card title="Authority">
            <Flow nodes={[
              { label: 'Logging agent', kind: 'ai' },
              { label: 'Swap agent proposes', kind: 'ai' },
              { label: 'engine.validateSwap', kind: 'rule' },
              { label: 'engine.gate', kind: 'rule' },
              { label: 'auto-apply ≥85%', kind: 'rule' },
              { label: 'or dietitian', kind: 'human' },
            ]} />
          </Card>

          {stage === 'proposing' && <Card title="Swap agent"><div className="row small"><Spinner /> Proposing an adjustment…</div></Card>}

          {result && (
            <>
              <Degraded note={result.degradedNote} />
              <Card title="This proposal">
                <EngineView change={{ ...result, engine }} />
                <div style={{ marginTop: 14 }}><TraceStrip ids={[logged?.logged?.traceId, result.traceId]} /></div>
              </Card>
            </>
          )}

          <Card title="History" hint={`${history.length}`} pad={false}>
            {history.length ? (
              <table className="t">
                <thead><tr><th>Change</th><th>Conf.</th><th>Outcome</th></tr></thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td>{h.summary}</td>
                      <td><Confidence value={h.confidence} /></td>
                      <td><Verdict verdict={h.status} /></td>
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

function Outcome({ logged, result, onAgain, go }) {
  const l = logged?.logged;
  const offPlan = (l?.unplanned || []).filter((u) => u.verdict === 'unplanned');
  const flagged = l?.flagged || [];

  let mark = 'done-mark'; let title; let line;
  if (!result) {
    title = 'On plan'; line = 'Nothing to change.';
  } else if (result.decision === 'auto_applied') {
    title = 'Plan updated'; line = result.userMessage;
  } else if (result.decision === 'pending') {
    mark += ' amber'; title = 'Sent to your dietitian'; line = result.userMessage;
  } else {
    mark += ' red'; title = 'No change made'; line = result.reason;
  }

  const v = result?.validation;
  return (
    <div className="stack center" style={{ gap: 12 }}>
      <div className={mark}>{mark.includes('amber') ? '🩺' : mark.includes('red') ? '✕' : '✓'}</div>
      <div>
        <h2>{title}</h2>
        <div className="small" style={{ marginTop: 4 }}>{line}</div>
      </div>
      <div className="stack small" style={{ gap: 3, textAlign: 'left' }}>
        {(l?.matched || []).map((m, i) => <div key={`m${i}`}>✓ {m.name} <span className="muted">· on plan</span></div>)}
        {offPlan.map((u, i) => <div key={`o${i}`} style={{ color: '#c2491a' }}>＋ {u.name} <span className="muted">· logged, not on plan</span></div>)}
        {flagged.map((f, i) => <div key={`f${i}`} style={{ color: 'var(--red)' }}>⚠ {f.name} <span className="muted">· {shortFlag(f.flag)} · dietitian notified</span></div>)}
        {v && v.removals.map((r) => <div key={r.id} style={{ textDecoration: 'line-through' }} className="muted">{r.name}</div>)}
        {v && v.additions.map((a, i) => <div key={`a${i}`} style={{ color: 'var(--blue)' }}>＋ {a.name} <span className="muted">· added to plan</span></div>)}
      </div>
      <div className="row" style={{ justifyContent: 'center' }}>
        <button className="btn" onClick={onAgain}>Report another</button>
        {result?.decision === 'pending' && <button className="btn ghost" onClick={() => go('review')}>Dietitian queue →</button>}
      </div>
    </div>
  );
}

/** The engine's verdict on a proposal. Shared with the dietitian queue. */
export function EngineView({ change }) {
  const e = change.engine || {};
  const p = change.proposal || {};
  const high = (e.conflicts || []).filter((c) => c.severity === 'high');
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row wrap">
        <Verdict verdict={change.decision || change.status} />
        <Confidence value={change.confidence} />
        {e.delta && <span className="chip mono">Δ {e.delta.kcal > 0 ? '+' : ''}{e.delta.kcal} kcal</span>}
        {e.kcalDriftPct != null && <span className={`chip ${e.kcalDriftPct > 0.15 ? 'amber' : ''}`}>{Math.round(e.kcalDriftPct * 100)}% of day</span>}
      </div>
      {(change.rationale || p.rationale) && <div className="small muted">{change.rationale || p.rationale}</div>}
      <div className="grid-2" style={{ gap: 12 }}>
        <div>
          <div className="tiny strong muted">REMOVE</div>
          {(e.removals || []).length ? e.removals.map((r) => (
            <div key={r.id} className="small" style={{ textDecoration: 'line-through' }}>{r.name} <span className="muted">{Math.round(r.kcal)} kcal</span></div>
          )) : <div className="small muted">—</div>}
        </div>
        <div>
          <div className="tiny strong muted">ADD</div>
          {(e.additions || []).length ? e.additions.map((a, i) => (
            <div key={i} className="small">{a.name} <span className="muted">{a.qty} {a.unit} · {Math.round(a.kcal)} kcal</span></div>
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
