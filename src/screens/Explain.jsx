import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, Spinner, Degraded, ErrorBox, TraceStrip, PlanBoard, Confidence } from '../components.jsx';

const SUGGESTIONS = [
  'Why is this in my plan?',
  'Is there too much of anything here?',
  'How does this help my goal?',
  'Can I skip this?',
];

export default function Explain({ user }) {
  const [plan, setPlan] = useState(null);
  const [picked, setPicked] = useState([]);
  const [question, setQuestion] = useState('');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get(`/api/plan/${user.id}`).then((p) => { setPlan(p); setPicked([]); setData(null); }).catch(setError);
  }, [user.id]);

  const toggleItem = (e) => setPicked((p) => (p.includes(e.id) ? p.filter((x) => x !== e.id) : [...p, e.id]));
  const toggleSlot = (s) => setPicked((p) => {
    const ids = s.items.map((i) => i.id);
    const all = ids.every((id) => p.includes(id));
    return all ? p.filter((id) => !ids.includes(id)) : [...new Set([...p, ...ids])];
  });

  async function ask(q) {
    const text = q ?? question;
    setBusy(true); setError(null); setData(null);
    try {
      setData(await api.post(`/api/explain/${user.id}`, { entryIds: picked, question: text }));
      if (q) setQuestion(q);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  const items = (plan?.slots || []).flatMap((s) => s.items).filter((i) => picked.includes(i.id));
  const kcal = Math.round(items.reduce((t, i) => t + (i.kcal || 0), 0));
  const ex = data?.explanation;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Explainable Recommendations</h1>
          <p className="sub">Every answer traced to the rule behind it. The model only puts it into words.</p>
        </div>
      </div>

      <Card title={`Today · ${plan?.date || ''}`} hint="tap a meal title for the whole meal, or single items">
        <PlanBoard slots={plan?.slots || []} selectedIds={picked} onItem={toggleItem} onSlot={toggleSlot} />
      </Card>

      <div className="split mt">
        <div className="stack">
          <Card title={picked.length ? `${picked.length} item${picked.length > 1 ? 's' : ''} selected · ~${kcal} kcal` : 'Nothing selected'}>
            {picked.length === 0 ? (
              <div className="small muted">Pick a meal or a few items above, then ask about them.</div>
            ) : (
              <div className="stack" style={{ gap: 10 }}>
                <div className="row wrap" style={{ gap: 5 }}>
                  {items.map((i) => (
                    <span key={i.id} className="chip" style={{ cursor: 'pointer' }} onClick={() => toggleItem(i)} title="Remove">
                      {i.name} ✕
                    </span>
                  ))}
                </div>
                <div className="row">
                  <input className="input grow" placeholder="Ask about these items…" value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && ask()} disabled={busy} />
                  <button className="btn primary" onClick={() => ask()} disabled={busy}>
                    {busy ? <Spinner /> : 'Ask'}
                  </button>
                </div>
                <div className="row wrap" style={{ gap: 6 }}>
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="chip" style={{ border: 0, cursor: 'pointer' }} disabled={busy} onClick={() => ask(s)}>{s}</button>
                  ))}
                </div>
              </div>
            )}
          </Card>

          {ex && (
            <div className="phone" style={{ maxWidth: 'none' }}>
              <div className="phone-top">
                <small>{data.question || 'Why this is in your plan'}</small>
                <h2>{data.entries.length === 1 ? data.entry.name : `${data.entries.length} items`}</h2>
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
          {busy && <div className="card empty"><Spinner /> Building the trail…</div>}
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
                  <div className="row"><span className={`chip ${data.entries.some((e) => e.macro_source === 'estimated') ? 'amber' : 'green'}`}>
                    {data.entries.some((e) => e.macro_source === 'estimated') ? '!' : '✓'}</span>
                    {data.entries.some((e) => e.macro_source === 'estimated') ? 'Estimated macros — must be caveated' : 'Macros from plan'}</div>
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
