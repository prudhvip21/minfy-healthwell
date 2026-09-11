import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, Spinner, Degraded, ErrorBox, TraceStrip, Bar } from '../components.jsx';

function Ring({ value, band }) {
  const r = 60; const c = 2 * Math.PI * r;
  const color = value >= 75 ? 'var(--green)' : value >= 50 ? 'var(--blue)' : value >= 25 ? 'var(--amber)' : 'var(--red)';
  return (
    <div className="ring">
      <svg width="140" height="140">
        <circle cx="70" cy="70" r={r} fill="none" stroke="var(--line-2)" strokeWidth="12" />
        <circle cx="70" cy="70" r={r} fill="none" stroke={color} strokeWidth="12" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - value / 100)} style={{ transition: 'stroke-dashoffset .8s' }} />
      </svg>
      <div className="val"><div><b>{value}</b><span>{band}</span></div></div>
    </div>
  );
}

function Trend({ points }) {
  if (!points?.length) return null;
  const w = 420; const h = 120; const pad = 22;
  const xs = (i) => pad + (i * (w - pad * 2)) / Math.max(1, points.length - 1);
  const ys = (v) => h - pad - (v / 100) * (h - pad * 2);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${xs(i)},${ys(p.score)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 'auto' }}>
      {[25, 50, 75].map((g) => (
        <g key={g}>
          <line x1={pad} x2={w - pad} y1={ys(g)} y2={ys(g)} stroke="var(--line-2)" />
          <text x={4} y={ys(g) + 4} fontSize="9" fill="var(--muted)">{g}</text>
        </g>
      ))}
      <path d={d} fill="none" stroke="var(--green)" strokeWidth="2.5" strokeLinejoin="round" />
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={xs(i)} cy={ys(p.score)} r="3.5" fill="#fff" stroke="var(--green)" strokeWidth="2" />
          <text x={xs(i)} y={ys(p.score) - 8} fontSize="10" textAnchor="middle" fill="var(--ink-2)">{p.score}</text>
          <text x={xs(i)} y={h - 5} fontSize="9" textAnchor="middle" fill="var(--muted)">{i === points.length - 1 ? 'now' : p.week}</text>
        </g>
      ))}
    </svg>
  );
}

export default function Score({ user }) {
  const [data, setData] = useState(null);
  const [narr, setNarr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { api.get(`/api/score/${user.id}`).then(setData).catch(setError); }, [user.id]);

  async function narrate() {
    setBusy(true); setError(null);
    try { setNarr(await api.post(`/api/score/${user.id}/narrate`)); } catch (e) { setError(e); } finally { setBusy(false); }
  }

  if (!data) return <div className="empty"><Spinner /></div>;
  const st = data.streak;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Behaviour Change Score</h1>
          <p className="sub">Arithmetic over engagement data. The model only explains it.</p>
        </div>
      </div>

      <div className="grid-2">
        <Card title={`${user.name}`} hint={user.persona}>
          <div className="row" style={{ gap: 24, alignItems: 'center' }}>
            <Ring value={data.score} band={data.band} />
            <div className="grow stack" style={{ gap: 10 }}>
              {data.components.map((c) => (
                <div key={c.key}>
                  <div className="row small">
                    <span className="grow">{c.label}</span>
                    <span className="muted">{c.display}</span>
                    <b className="mono" style={{ width: 54, textAlign: 'right' }}>{c.contribution}/{Math.round(c.weight * 100)}</b>
                  </div>
                  <Bar value={c.contribution / (c.weight * 100)} tone={c.contribution / (c.weight * 100) < 0.35 ? 'red' : c.contribution / (c.weight * 100) < 0.65 ? 'amber' : ''} />
                </div>
              ))}
            </div>
          </div>
        </Card>

        <Card title="Six-week trend">
          <Trend points={data.history} />
        </Card>

        <Card title="Dynamic streak" hint="rule-based target">
          <div className="row" style={{ gap: 18, marginBottom: 12 }}>
            <div><div className="tiny muted">CURRENT</div><div style={{ fontSize: 26, fontWeight: 700 }}>🔥 {st.current}</div></div>
            <div><div className="tiny muted">NEXT TARGET</div><div style={{ fontSize: 26, fontWeight: 700 }}>{st.target} days</div></div>
            <div className="grow">
              <div className="tiny muted">LADDER ({st.band})</div>
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                {st.ladder.map((t) => <span key={t} className={`chip ${t === st.target ? 'green' : ''}`}>{t}d</span>)}
              </div>
            </div>
          </div>
          <Bar value={st.current / st.target} />
          <p className="small muted" style={{ marginTop: 10 }}>{st.rationale}</p>
        </Card>

        <Card title="What it means"
          actions={<button className="btn sm primary" onClick={narrate} disabled={busy}>{busy ? <Spinner /> : '✦'} Explain my score</button>}>
          <ErrorBox error={error} />
          <Degraded note={narr?.degradedNote} />
          {narr ? (
            <div className="stack" style={{ gap: 10 }}>
              <b>{narr.narration.headline}</b>
              <div className="small"><span className="chip green">working</span> {narr.narration.what_is_working}</div>
              <div className="small"><span className="chip amber">fix</span> {narr.narration.what_to_fix}</div>
              <div className="banner blue small"><span>→</span><div><b>Next 48 hours:</b> {narr.narration.next_step}</div></div>
              <TraceStrip ids={[narr.traceId]} />
            </div>
          ) : <div className="small muted">Sees only the numbers on this page.</div>}
        </Card>
      </div>
    </>
  );
}
