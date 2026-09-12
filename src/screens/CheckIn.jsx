import { useEffect, useState } from 'react';
import { api } from '../api.js';
import MealInput from '../MealInput.jsx';
import {
  Card, Spinner, Confidence, Degraded, ErrorBox, Verdict, TraceStrip, PlanBoard, Macros, Flow, shortFlag,
} from '../components.jsx';

const SAMPLES = {
  ananya: ['3 idlis with coconut chutney', 'Handful of roasted peanuts after my walk', 'Tomato dal, cabbage curry and rice'],
  rohit: ['Chicken biryani and a coke at a client lunch', '2 rotis with tomato pappu and raitha', 'Masala dosa and filter coffee'],
  meera: ['Curd rice for lunch', 'Poha with ginger chutney', 'Chamomile tea before bed'],
};

export default function CheckIn({ user, onChange }) {
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [justIds, setJustIds] = useState([]);
  const [round, setRound] = useState(0);      // remounts the input for "log another"

  useEffect(() => { api.get(`/api/plan/${user.id}`).then(setPlan).catch(setError); }, [user.id]);

  async function refreshPlan(before) {
    const fresh = await api.get(`/api/plan/${user.id}`);
    setPlan(fresh);
    setJustIds(fresh.slots.flatMap((s) => s.items).filter((i) => i.status !== 'planned' && !before.has(i.id)).map((i) => i.id));
  }

  async function submit(payload) {
    setBusy(true); setError(null); setResult(null);
    const before = new Set(plan?.slots.flatMap((s) => s.items).filter((i) => i.status !== 'planned').map((i) => i.id));
    try {
      // Log and show it at once; the plan-swap agent is a separate, slower hop.
      const r = payload.modality === 'menu'
        ? await api.post('/api/checkin/select', { userId: user.id, slot: payload.slot, entryIds: payload.entryIds, extras: payload.extras })
        : await api.post('/api/checkin', { userId: user.id, ...payload, autoAdjust: false });
      setResult(r);
      await refreshPlan(before);
      setBusy(false);
      onChange?.();

      if (r.logged.unplanned.length) {
        setAdjusting(true);
        try {
          const adjustment = await api.post('/api/plan/propose', {
            userId: user.id, trigger: 'checkin',
            unplanned: r.logged.unplanned.map((u) => ({ name: u.name, qty: u.qty, unit: u.unit, kcal: u.kcal })),
          });
          setResult((prev) => ({ ...prev, adjustment }));
          await refreshPlan(before);
          onChange?.();
        } catch (e) {
          setResult((prev) => ({ ...prev, adjustment: { error: e.message } }));
        } finally {
          setAdjusting(false);
        }
      }
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  function again() { setResult(null); setError(null); setJustIds([]); setRound((n) => n + 1); }

  const logged = result?.logged;
  const adj = result?.adjustment;
  const traceIds = result ? [result.transcript?.traceId, logged?.traceId, result.reward?.traceId, adj?.traceId] : [];
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <div className="page-head">
        <div><h1>Daily Check-in</h1></div>
      </div>

      <div className="split phone-left">
        <div>
          <div className="phone screen">
            <div className="phone-top">
              <small>{greet}, {user.name.split(' ')[0]}</small>
              <h2>{logged ? 'All done' : 'What did you eat?'}</h2>
            </div>

            <div className="phone-body stack">
              {!logged ? (
                <>
                  <MealInput key={round} onSubmit={submit} busy={busy} samples={SAMPLES[user.id]} plan={plan} busyLabel="Logging…" />
                  <ErrorBox error={error} />
                </>
              ) : (
                <Done result={result} adjusting={adjusting} onAgain={again} />
              )}
            </div>
          </div>
        </div>

        <div className="stack">
          <Card title={`Today · ${plan?.date || ''}`}>
            <PlanBoard slots={plan?.slots || []} justIds={justIds} />
            <div style={{ marginTop: 14, maxWidth: 460 }}><Macros totals={plan?.totals} /></div>
          </Card>

          {logged && (
            <>
              <Degraded note={logged.degradedNote || result.reward?.degradedNote || adj?.degradedNote || result.transcript?.degradedNote} />
              <Card title="Extracted" hint={`overall ${Math.round((logged.overallConfidence || 0) * 100)}%`}>
                {result.transcript && <div className="small muted" style={{ marginBottom: 8 }}>Whisper: “{result.transcript.text}”</div>}
                {logged.items.map((it, i) => (
                  <div key={i} className="row small" style={{ padding: '4px 0' }}>
                    <span className="grow">{it.name} <span className="muted">{it.qty ?? ''} {it.unit || ''}</span>
                      {it.matched && <span className="muted"> → {it.matched.name}</span>}</span>
                    <Confidence value={it.confidence} />
                    <Verdict verdict={it.verdict} />
                  </div>
                ))}
              </Card>
              {(adjusting || (adj && !adj.error)) && (
                <Card title="Swap agent → engine" hint={adj ? `${Math.round((adj.confidence || 0) * 100)}% confidence` : 'running'}>
                  {adjusting ? <div className="row small"><Spinner /> Proposing…</div> : (
                    <div className="stack small" style={{ gap: 6 }}>
                      <div className="row"><Verdict verdict={adj.decision} /><span className="grow">{adj.reason}</span></div>
                      <div className="mono">Δ {adj.validation.delta.kcal > 0 ? '+' : ''}{adj.validation.delta.kcal} kcal · {Math.round(adj.validation.kcalDriftPct * 100)}% of day</div>
                    </div>
                  )}
                </Card>
              )}
              <Card><TraceStrip ids={traceIds} /></Card>
            </>
          )}

          <Card title="Pipeline">
            <Flow nodes={[
              { label: 'Input guardrail', kind: 'rule' },
              { label: 'GPT-5 / Whisper', kind: 'ai' },
              { label: 'Engine match', kind: 'rule' },
              { label: 'Allergy gate', kind: 'rule' },
              { label: 'Reward', kind: 'ai' },
              { label: 'Swap agent', kind: 'ai' },
              { label: 'Engine gate', kind: 'rule' },
              { label: 'Dietitian', kind: 'human' },
            ]} />
          </Card>
        </div>
      </div>
    </>
  );
}

/** The finished state. The flow ends here — one clear confirmation, one next action. */
function Done({ result, adjusting, onAgain }) {
  const { logged, reward, adjustment: adj } = result;
  const offPlan = logged.unplanned.filter((u) => u.verdict === 'unplanned');

  return (
    <div className="stack center" style={{ gap: 14 }}>
      <div className="done-mark">✓</div>
      <div>
        <h2>{logged.slot} logged</h2>
        {reward && !reward.error && <div className="small" style={{ marginTop: 4 }}>{reward.headline}</div>}
      </div>

      <div className="stack" style={{ gap: 4, textAlign: 'left' }}>
        {logged.matched.map((m, i) => <div key={`m${i}`} className="small">✓ {m.name}</div>)}
        {offPlan.map((u, i) => <div key={`u${i}`} className="small" style={{ color: '#c2491a' }}>＋ {u.name} <span className="muted">· not on plan</span></div>)}
        {logged.flagged.map((f, i) => <div key={`f${i}`} className="small" style={{ color: 'var(--red)' }}>⚠ {f.name} <span className="muted">· {shortFlag(f.flag)} · dietitian notified</span></div>)}
      </div>

      {adjusting && <div className="small muted"><Spinner /> Balancing the rest of your day…</div>}
      {adj && !adj.error && (
        <div className={`banner small ${adj.decision === 'auto_applied' ? 'green' : 'amber'}`} style={{ textAlign: 'left' }}>
          <span>{adj.decision === 'auto_applied' ? '✓' : '🩺'}</span>
          <div>{adj.decision === 'auto_applied' ? 'Rest of today adjusted.' : adj.decision === 'pending' ? 'Your dietitian will confirm a small change.' : 'No change to your plan.'}</div>
        </div>
      )}

      <button className="btn" onClick={onAgain} disabled={adjusting}>Log another meal</button>
    </div>
  );
}
