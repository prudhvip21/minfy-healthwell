import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, Spinner, Degraded, ErrorBox, TraceStrip } from '../components.jsx';

const BAND_TONE = { reach_out: 'red', restart: 'amber', nudge: 'blue', celebrate: 'green' };
const WHAT_IF = [['', 'Actual'], ['0.05', '5%'], ['0.2', '20%'], ['0.5', '50%'], ['0.85', '85%']];

export default function Nudges({ user, onChange }) {
  const [data, setData] = useState(null);
  const [whatIf, setWhatIf] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [last, setLast] = useState(null);

  const load = () => api.get(`/api/nudges/${user.id}${whatIf ? `?adherence=${whatIf}` : ''}`).then(setData).catch(setError);
  useEffect(() => { load(); }, [user.id, whatIf]);

  async function generate() {
    setBusy(true); setError(null);
    try {
      const r = await api.post(`/api/nudges/${user.id}/generate`, { count: 3, adherence: whatIf || null });
      setLast(r);
      setData((d) => ({ ...d, signals: r.signals, nudges: r.nudges }));
      onChange?.();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  async function mark(id, status) {
    await api.post(`/api/nudges/item/${id}/status`, { status });
    load();
  }

  const s = data?.signals;
  const latest = (data?.nudges || []).slice(0, 3);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Re-engagement Nudges</h1>
          <p className="sub">Rules pick the tone from adherence. The agent writes the words and the moment.</p>
        </div>
        <div className="actions">
          <div className="tabs" title="What-if: preview the tone band at a different adherence">
            {WHAT_IF.map(([v, l]) => (
              <button key={l} className={`tab ${whatIf === v ? 'on' : ''}`} onClick={() => setWhatIf(v)}>{l}</button>
            ))}
          </div>
          <button className="btn primary" onClick={generate} disabled={busy}>
            {busy ? <><Spinner /> Writing…</> : '✦ Generate'}
          </button>
        </div>
      </div>

      {s && data.bands && (
        <div className="grid-3" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))', marginBottom: 16 }}>
          {data.bands.map((b) => {
            const on = s.tone.key === b.key;
            return (
              <div key={b.key} className="card stat" style={on ? { borderColor: `var(--${BAND_TONE[b.key]})`, boxShadow: `0 0 0 2px var(--${BAND_TONE[b.key]}-soft)` } : { opacity: 0.55 }}>
                <div className="row"><span className={`chip ${BAND_TONE[b.key]}`}>{b.range}</span>{b.escalate && <span className="tiny muted">RM call</span>}</div>
                <div className="v" style={{ fontSize: 17 }}>{b.label}</div>
                {on && <div className="d">{user.name.split(' ')[0]} · {Math.round(s.adherence7 * 100)}%{s.simulated ? ' (what-if)' : ''}</div>}
              </div>
            );
          })}
        </div>
      )}

      <div className="split">
        <div>
          <div className="phone" style={{ background: 'linear-gradient(160deg,#1d2b36,#2d4252)', border: 0 }}>
            <div style={{ padding: '26px 18px 8px', color: '#fff', textAlign: 'center' }}>
              <div style={{ fontSize: 44, fontWeight: 300, lineHeight: 1 }}>
                {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
              </div>
              <div className="small" style={{ opacity: 0.7 }}>{new Date().toDateString()}</div>
            </div>
            <div className="stack" style={{ padding: 14, gap: 8 }}>
              {latest.length === 0 && <div className="small center" style={{ color: '#c7d2da', padding: 30 }}>No notifications yet.</div>}
              {latest.map((n) => {
                const r = n.rationale || {};
                const rm = r.escalate && /rm|call/i.test(r.cta || '');
                return (
                  <div key={n.id} className="notif" style={{ background: 'rgba(255,255,255,.95)', opacity: n.status === 'ignored' ? 0.5 : 1 }}>
                    <span className="app-ico">H</span>
                    <div className="grow">
                      <div className="row"><b className="small">{r.title || 'HealthWise'}</b><span className="when" style={{ marginLeft: 'auto' }}>{n.send_at}</span></div>
                      <div className="small">{n.copy}</div>
                      <div className="row" style={{ marginTop: 7, gap: 6 }}>
                        {n.status === 'queued' ? (
                          <>
                            <button className={`btn sm ${rm ? 'primary' : ''}`} onClick={() => mark(n.id, rm ? 'escalated' : 'opened')}>{r.cta || 'Open'}</button>
                            <button className="btn sm ghost" onClick={() => mark(n.id, 'ignored')}>Dismiss</button>
                          </>
                        ) : n.status === 'escalated'
                          ? <span className="chip green">✓ Your RM will call you</span>
                          : <span className={`chip ${n.status === 'opened' ? 'green' : ''}`}>{n.status}</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="stack">
          <ErrorBox error={error} />
          <Degraded note={last?.degradedNote} />

          <Card title="Engine signals" hint="rules">
            {s?.signals?.length ? (
              <div className="row wrap" style={{ gap: 6 }}>
                {s.signals.map((x) => <span key={x.key} className={`chip ${x.severity === 'high' ? 'red' : x.severity === 'medium' ? 'amber' : ''}`} title={x.detail}>{x.key} · {x.detail}</span>)}
              </div>
            ) : <div className="small muted">None firing.</div>}
          </Card>

          {latest.length > 0 && (
            <Card title="Why" pad={false}>
              <table className="t">
                <tbody>
                  {latest.map((n) => (
                    <tr key={n.id}>
                      <td style={{ width: 110 }}>
                        <span className={`chip ${BAND_TONE[n.rationale?.band] || ''}`}>{n.rationale?.band_label}</span>
                        <div className="tiny muted" style={{ marginTop: 4 }}>{n.rationale?.angle} · {n.channel} {n.send_at}</div>
                      </td>
                      <td className="small">{n.rationale?.why}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          {last && <Card><TraceStrip ids={[last.traceId]} /></Card>}
        </div>
      </div>
    </>
  );
}
