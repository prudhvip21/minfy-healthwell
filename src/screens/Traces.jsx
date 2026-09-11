import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Stat, TraceRow, Spinner } from '../components.jsx';

export default function Traces({ user }) {
  const [data, setData] = useState(null);
  const [scope, setScope] = useState('all');
  const [route, setRoute] = useState('');
  const [auto, setAuto] = useState(true);

  const load = () => api.get(`/api/traces?limit=200${scope === 'user' ? `&userId=${user.id}` : ''}`).then(setData).catch(() => {});
  useEffect(() => { load(); }, [scope, user.id]);
  useEffect(() => {
    if (!auto) return undefined;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [auto, scope, user.id]);

  if (!data) return <div className="empty"><Spinner /></div>;
  const t = data.totals || {};
  const routes = [...new Set(data.traces.map((x) => x.route))].sort();
  const shown = route ? data.traces.filter((x) => x.route === route) : data.traces;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Trace Console</h1>
          <p className="sub">Every model call — cost, latency, tokens, guardrails. Click a row for the full prompt.</p>
        </div>
        <div className="actions">
          <div className="tabs">
            <button className={`tab ${scope === 'all' ? 'on' : ''}`} onClick={() => setScope('all')}>All users</button>
            <button className={`tab ${scope === 'user' ? 'on' : ''}`} onClick={() => setScope('user')}>{user.name.split(' ')[0]}</button>
          </div>
          <select className="select" style={{ width: 'auto' }} value={route} onChange={(e) => setRoute(e.target.value)}>
            <option value="">All routes</option>
            {routes.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <label className="row small"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> live</label>
        </div>
      </div>

      <div className="grid-3" style={{ gridTemplateColumns: 'repeat(5, minmax(0,1fr))', marginBottom: 16 }}>
        <Stat k="Model calls" v={t.calls || 0} />
        <Stat k="Tokens in → out" v={`${fmt(t.input_tokens)} → ${fmt(t.output_tokens)}`} />
        <Stat k="Est. cost" v={`$${(t.cost_usd || 0).toFixed(3)}`} d="list price" />
        <Stat k="Avg latency" v={t.avg_latency ? `${(t.avg_latency / 1000).toFixed(1)}s` : '—'} />
        <Stat k="Degraded / errors" v={`${t.degraded || 0} / ${t.errors || 0}`} tone={(t.errors || 0) > 0 ? 'red' : undefined} />
      </div>

      <div className="card card-pad">
        {shown.length === 0 ? <div className="empty">No calls yet.</div>
          : shown.map((x) => <TraceRow key={x.id} t={x} showUser />)}
      </div>
    </>
  );
}

function fmt(n) {
  if (!n) return '0';
  return n > 9999 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
