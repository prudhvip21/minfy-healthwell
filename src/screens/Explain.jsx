import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, Spinner, Degraded, ErrorBox, TraceStrip, PlanList, Confidence } from '../components.jsx';

export default function Explain({ user }) {
  const [plan, setPlan] = useState(null);
  const [selected, setSelected] = useState(null);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { api.get(`/api/plan/${user.id}`).then(setPlan).catch(setError); }, [user.id]);

  async function explain(entry) {
    setSelected(entry); setBusy(true); setError(null); setData(null);
    try { setData(await api.post(`/api/explain/${user.id}/${entry.id}`)); } catch (e) { setError(e); } finally { setBusy(false); }
  }

  const ex = data?.explanation;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Explainable Recommendations</h1>
          <p className="sub">Every recommendation traced to the rule behind it. The model only puts it into words.</p>
        </div>
      </div>

      <div className="split">
        <div className="stack">
          <Card title="Tap an item — why is it here?" hint={plan?.date}>
            <PlanList slots={plan?.slots || []} onItem={explain} selectedId={selected?.id} />
          </Card>
          {ex && (
            <div className="phone" style={{ maxWidth: 'none' }}>
              <div className="phone-top">
                <small>Why it's in your plan</small>
                <h2>{selected.name}</h2>
              </div>
              <div className="phone-body stack" style={{ gap: 10 }}>
                <p>{ex.plain_language}</p>
                <p className="small"><b>For you:</b> {ex.why_it_matters}</p>
                <p className="small muted"><b>Would change if:</b> {ex.what_would_change_it}</p>
                {ex.caveat && <div className="banner amber small"><span>ⓘ</span><div>{ex.caveat}</div></div>}
              </div>
            </div>
          )}
        </div>

        <div className="stack">
          <ErrorBox error={error} />
          {busy && <div className="card empty"><Spinner /> Explaining…</div>}
          {!data && !busy && <div className="card empty">Pick an item.</div>}
          {data && (
            <>
              <Degraded note={data.degradedNote} />
              <Card title="Rule trail" hint="engine · no model">
                <div className="stack" style={{ gap: 8 }}>
                  {data.trail.map((t, i) => (
                    <div key={i} className="row" style={{ alignItems: 'flex-start' }}>
                      <span className="chip" style={{ minWidth: 26, justifyContent: 'center' }}>{i + 1}</span>
                      <div className="grow">
                        <b className="small">{t.step}</b>
                        <div className="small" style={{ color: t.detail.startsWith('CONFLICT') ? 'var(--red)' : undefined }}>{t.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
              <Card title="Guardrails">
                <div className="stack small" style={{ gap: 6 }}>
                  <div className="row"><span className="chip green">✓</span> Grounded in the trail only</div>
                  <div className="row"><span className={`chip ${data.entry.macro_source === 'estimated' ? 'amber' : 'green'}`}>{data.entry.macro_source === 'estimated' ? '!' : '✓'}</span>
                    {data.entry.macro_source === 'estimated' ? 'Estimated macros — must be caveated' : 'Macros from plan'}</div>
                  <div className="row"><span className={`chip ${data.conflicts.length ? 'red' : 'green'}`}>{data.conflicts.length ? '⛔' : '✓'}</span>
                    {data.conflicts.length ? 'Profile conflict — must lead with it' : 'No profile conflict'}</div>
                  <div className="row"><Confidence value={ex.confidence} /> <span className="muted">&lt; 85% → RM review</span></div>
                </div>
              </Card>
              <Card><TraceStrip ids={[data.traceId]} /></Card>
            </>
          )}
        </div>
      </div>
    </>
  );
}
