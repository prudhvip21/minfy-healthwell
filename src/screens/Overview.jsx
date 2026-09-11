import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, Spinner, Bar, Flow, ErrorBox } from '../components.jsx';

const STORY = {
  ananya: { lead: 'checkin', text: 'Logs daily. Try a photo — then “roasted peanuts”.' },
  rohit: { lead: 'planloop', text: 'Eats off-plan. Report a biryani, watch the swap.' },
  meera: { lead: 'nudges', text: 'Silent for days. See how the platform reaches out.' },
};

export default function Overview({ users, setUserId, go, onChange }) {
  const [health, setHealth] = useState(null);
  const [funnel, setFunnel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState(null);
  const [error, setError] = useState(null);

  const load = () => {
    api.get('/api/health').then(setHealth);
    api.get('/api/funnel').then(setFunnel);
  };
  useEffect(load, []);

  async function reparse() {
    if (!confirm('Re-parse every plan document with GPT-5? This clears demo state and makes one model call per document.')) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post('/api/reset', { reparse: true });
      setLog(r);
      load();
      onChange?.();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Platform 2.0</h1>
          <p className="sub">The rules engine decides. Agents propose. Live GPT-5 on a real dietitian plan.</p>
        </div>
      </div>

      <div className="grid-3" style={{ marginBottom: 16 }}>
        {users.map((u) => (
          <div key={u.id} className="card card-pad stack" style={{ gap: 10 }}>
            <div className="row">
              <span style={{ fontSize: 28 }}>{u.avatar}</span>
              <div className="grow">
                <b>{u.name}</b>
                <div className="tiny muted">{u.age}{u.sex} · {u.goal}</div>
              </div>
              <span className={`chip ${u.score >= 75 ? 'green' : u.score >= 50 ? 'blue' : u.score >= 25 ? 'amber' : 'red'}`}>{u.score} · {u.band}</span>
            </div>
            <div className="row wrap tiny">
              <span className="chip">{u.diet}</span>
              {u.allergies.map((a) => <span key={a} className="chip red">{a} allergy</span>)}
              {u.conditions.map((c) => <span key={c} className="chip">{c}</span>)}
            </div>
            <div className="small">{STORY[u.id]?.text}</div>
            <div className="row small muted">
              <span>🔥 {u.streak}d streak</span>
              <span>· last log {u.silent ?? '—'}d ago</span>
              {u.pendingReviews > 0 && <span className="chip amber">{u.pendingReviews} in review</span>}
            </div>
            <button className="btn sm" onClick={() => { setUserId(u.id); go(STORY[u.id]?.lead || 'checkin'); }}>
              Start as {u.name.split(' ')[0]} →
            </button>
          </div>
        ))}
      </div>

      <div className="grid-2">
        <Card title="Plan documents"
          actions={<button className="btn sm" onClick={reparse} disabled={busy || !health?.hasKey}>{busy ? <Spinner /> : '↻'} Re-parse</button>}>
          <ErrorBox error={error} />
          {!health ? <Spinner /> : (
            <div className="stack" style={{ gap: 10 }}>
              <Flow nodes={[
                { label: '.docx' },
                { label: 'mammoth → HTML tables', kind: 'rule' },
                { label: 'GPT-5 structured extract', kind: 'ai' },
                { label: 'engine: slots, macros*', kind: 'rule' },
                { label: 'profile conflicts', kind: 'rule' },
                { label: 'dietitian review', kind: 'human' },
              ]} />
              <table className="t">
                <thead><tr><th>User</th><th>Source</th><th>Status</th><th className="num">Cycle</th></tr></thead>
                <tbody>
                  {health.plans.map((p) => (
                    <tr key={p.user_id}>
                      <td>{users.find((u) => u.id === p.user_id)?.name.split(' ')[0]}</td>
                      <td><code>{p.source_file || '—'}</code></td>
                      <td>
                        <span className={`chip ${p.parse_status === 'parsed' ? 'green' : p.parse_status === 'failed' ? 'amber' : ''}`}>{p.parse_status === 'failed' ? 'fallback' : p.parse_status}</span>
                        {p.parse_note && <div className="tiny muted" style={{ maxWidth: 260 }}>{p.parse_note}</div>}
                      </td>
                      <td className="num">{p.duration_days}d</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="tiny muted">
                {health.planFiles.length} in <code>plans/</code>{health.planFiles.length < users.length && ' · shared across users'} · * macros estimated
              </div>
              {log && (
                <div className="banner green small"><span>✓</span><div>{log.log.map((l, i) => <div key={i}>{l}</div>)}</div></div>
              )}
            </div>
          )}
        </Card>

        <Card title="Engagement funnel" hint="no model">
          {!funnel ? <Spinner /> : (
            <div className="stack" style={{ gap: 14 }}>
              {Object.entries(funnel.cohorts).map(([cohort, weeks]) => (
                <div key={cohort}>
                  <div className="row small" style={{ marginBottom: 4 }}>
                    <b className="grow">{cohort}</b><span className="muted">{weeks[0].total} onboarded</span>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    {weeks.map((w) => (
                      <div key={w.week} className="grow">
                        <Bar value={w.rate / 100} tone={w.rate < 40 ? 'amber' : ''} />
                        <div className="tiny muted" style={{ marginTop: 3 }}>W{w.week} · {w.rate}%</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              <div className="tiny muted">W1 → W2 is the drop Phase 1 must move. Synthetic cohorts.</div>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
