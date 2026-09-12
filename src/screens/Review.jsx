import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Spinner, ErrorBox, Verdict, Confidence, TraceStrip } from '../components.jsx';
import { EngineView } from './PlanLoop.jsx';

const iconFor = (r) => {
  if (r.kind === 'swap') return '🔁';
  if (r.kind === 'exposure') return '⚠';
  if (r.proposal?.conflict) return r.proposal.conflict.severity === 'high' ? '⛔' : '⚠';
  return '📄';
};

export default function Review({ user, users, onChange }) {
  const [rows, setRows] = useState([]);
  const [mine, setMine] = useState(false);
  const [filter, setFilter] = useState('pending');
  const [busyId, setBusyId] = useState(null);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState(null);

  const load = () => api.get(`/api/review${mine ? `?userId=${user.id}` : ''}`).then(setRows).catch(setError);
  useEffect(() => { load(); }, [mine, user.id]);

  async function decide(id, decision) {
    setBusyId(id); setError(null);
    try {
      await api.post(`/api/review/${id}/decide`, { decision, reviewer: 'Dr. Kavya Rao (dietitian)' });
      await load();
      onChange?.();
    } catch (e) { setError(e); } finally { setBusyId(null); }
  }

  const shown = rows.filter((r) => (filter === 'pending' ? r.status === 'pending' : r.status !== 'pending'));
  const pending = rows.filter((r) => r.status === 'pending').length;
  const first = (id) => (users.find((u) => u.id === id)?.name || id).split(' ')[0];

  return (
    <>
      <div className="page-head">
        <div><h1>Dietitian Queue</h1></div>
        <div className="actions">
          <button className="btn sm ghost" onClick={() => setMine(!mine)}>
            {mine ? first(user.id) : 'All users'}
          </button>
          <div className="tabs">
            <button className={`tab ${filter === 'pending' ? 'on' : ''}`} onClick={() => setFilter('pending')}>Pending {pending > 0 && <b>{pending}</b>}</button>
            <button className={`tab ${filter === 'decided' ? 'on' : ''}`} onClick={() => setFilter('decided')}>Decided</button>
          </div>
        </div>
      </div>

      <ErrorBox error={error} />

      <div className="card">
        {shown.length === 0 && <div className="empty">{filter === 'pending' ? 'Queue is clear.' : 'Nothing decided yet.'}</div>}
        {shown.map((r) => (
          <div key={r.id}>
            <div className="q-row" onClick={() => setOpen(open === r.id ? null : r.id)}>
              <span title={r.kind.replace('_', ' ')}>{iconFor(r)}</span>
              <span className="q-sum">{r.summary}</span>
              <span className="q-user">{first(r.user_id)}</span>
              {r.status === 'pending' ? (
                <span className="row" style={{ gap: 6 }} onClick={(e) => e.stopPropagation()}>
                  <button className="btn sm primary" disabled={busyId === r.id} onClick={() => decide(r.id, 'approved')}>
                    {busyId === r.id ? <Spinner /> : 'Approve'}
                  </button>
                  <button className="btn sm danger" disabled={busyId === r.id} onClick={() => decide(r.id, 'rejected')} title="Reject">✕</button>
                </span>
              ) : <Verdict verdict={r.status} />}
            </div>

            {open === r.id && (
              <div className="q-detail stack">
                <div className="small muted">{r.reason}</div>
                {r.kind === 'swap' && <EngineView change={r} />}
                {r.kind === 'parse_review' && r.proposal?.source_text && (
                  <div className="small">Source: <code>{r.proposal.source_text}</code> <Confidence value={r.confidence} /></div>
                )}
                {r.status !== 'pending' && (
                  <div className="tiny muted">{r.reviewer || 'engine'} · {r.decided_at?.slice(0, 16)}</div>
                )}
                {r.trace_id && <TraceStrip ids={[r.trace_id]} title="Agent call" />}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
