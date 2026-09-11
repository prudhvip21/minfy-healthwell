import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, Spinner, ErrorBox, Verdict, Confidence, TraceStrip } from '../components.jsx';
import { EngineView } from './PlanLoop.jsx';

export default function Review({ user, users, onChange }) {
  const [rows, setRows] = useState([]);
  const [scope, setScope] = useState('all');
  const [filter, setFilter] = useState('pending');
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  const load = () => api.get(`/api/review${scope === 'user' ? `?userId=${user.id}` : ''}`).then(setRows).catch(setError);
  useEffect(() => { load(); }, [scope, user.id]);

  async function decide(id, decision) {
    setBusyId(id); setError(null);
    try {
      await api.post(`/api/review/${id}/decide`, { decision, reviewer: 'Dr. Kavya Rao (dietitian)' });
      await load();
      onChange?.();
    } catch (e) { setError(e); } finally { setBusyId(null); }
  }

  const shown = rows.filter((r) => (filter === 'all' ? true : filter === 'pending' ? r.status === 'pending' : r.status !== 'pending'));
  const counts = {
    pending: rows.filter((r) => r.status === 'pending').length,
    swap: rows.filter((r) => r.status === 'pending' && r.kind === 'swap').length,
    parse: rows.filter((r) => r.status === 'pending' && r.kind === 'parse_review').length,
    exposure: rows.filter((r) => r.status === 'pending' && r.kind === 'exposure').length,
  };
  const nameOf = (id) => users.find((u) => u.id === id)?.name || id;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dietitian Queue</h1>
          <p className="sub">Everything the platform won't decide alone. Approval re-runs the engine first.</p>
        </div>
        <div className="actions">
          <div className="tabs">
            <button className={`tab ${scope === 'all' ? 'on' : ''}`} onClick={() => setScope('all')}>All users</button>
            <button className={`tab ${scope === 'user' ? 'on' : ''}`} onClick={() => setScope('user')}>{user.name.split(' ')[0]}</button>
          </div>
          <div className="tabs">
            {['pending', 'decided', 'all'].map((f) => (
              <button key={f} className={`tab ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>{f}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="row wrap" style={{ marginBottom: 14 }}>
        <span className="chip amber">{counts.pending} pending</span>
        <span className="chip">{counts.swap} plan changes</span>
        <span className="chip">{counts.parse} document checks</span>
        {counts.exposure > 0 && <span className="chip red">{counts.exposure} conflict alerts</span>}
      </div>

      <ErrorBox error={error} />

      <div className="stack">
        {shown.length === 0 && <div className="card empty">Nothing here. {filter === 'pending' && 'The queue is clear.'}</div>}
        {shown.map((r) => (
          <Card key={r.id}
            title={r.summary}
            icon={r.kind === 'swap' ? '🔁' : r.kind === 'exposure' ? '⚠' : r.proposal?.conflict ? '⛔' : '📄'}
            hint={`${nameOf(r.user_id)} · #${r.id} · ${r.created_at?.slice(0, 16)}`}>
            <div className="stack" style={{ gap: 10 }}>
              {r.kind === 'swap' ? (
                <EngineView change={r} />
              ) : r.proposal?.conflict ? (
                <>
                  <div className="row wrap">
                    <span className={`chip ${r.proposal.conflict.severity === 'high' ? 'red' : 'amber'}`}>
                      {r.proposal.conflict.kind} · {r.proposal.conflict.allergen} · {r.proposal.conflict.severity}
                    </span>
                    <span className="small muted">from {r.proposal.source_file}</span>
                  </div>
                  <div className="small">
                    {r.kind === 'exposure'
                      ? `Reported at ${r.proposal.occurrences?.[0]?.slot} · ${r.proposal.occurrences?.[0]?.date} · logged and counted`
                      : `Affects ${(r.proposal.items || [r.proposal.conflict.item]).join(', ')} · ${(r.proposal.occurrences || []).length}× in plan`}
                  </div>
                </>
              ) : (
                <>
                  <div className="row wrap">
                    <span className="small">Parser confidence</span> <Confidence value={r.confidence} />
                    <span className="small muted">from {r.proposal?.source_file}</span>
                  </div>
                  <div className="small">Source: <code>{r.proposal?.source_text}</code>
                    {(r.proposal?.occurrences || []).length > 1 && <span className="muted"> · {r.proposal.occurrences.length}×</span>}</div>
                </>
              )}

              <div className="row">
                {r.status === 'pending' ? (
                  <>
                    <button className="btn primary sm" disabled={busyId === r.id} onClick={() => decide(r.id, 'approved')}>
                      {busyId === r.id ? <Spinner /> : '✓'} {r.kind === 'swap' ? 'Approve change' : 'Acknowledge'}
                    </button>
                    <button className="btn sm danger" disabled={busyId === r.id} onClick={() => decide(r.id, 'rejected')}>✕ Reject</button>
                  </>
                ) : (
                  <>
                    <Verdict verdict={r.status} />
                    <span className="small muted">{r.reviewer ? `by ${r.reviewer}` : 'by the engine'} · {r.decided_at?.slice(0, 16)}</span>
                  </>
                )}
              </div>
              {r.trace_id && <TraceStrip ids={[r.trace_id]} title="Agent call" />}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
