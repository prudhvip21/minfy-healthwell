import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, Spinner, Degraded, ErrorBox, TraceStrip, Bar } from '../components.jsx';

const COLOURS = {
  adherence: 'var(--green)',
  consistency: 'var(--blue)',
  streak: 'var(--orange)',
  momentum: 'var(--amber)',
};

function Ring({ value, band }) {
  const r = 62; const c = 2 * Math.PI * r;
  const colour = value >= 75 ? 'var(--green)' : value >= 50 ? 'var(--blue)' : value >= 25 ? 'var(--amber)' : 'var(--red)';
  return (
    <div className="ring">
      <svg width="150" height="150" viewBox="0 0 150 150">
        <circle cx="75" cy="75" r={r} fill="none" stroke="var(--line-2)" strokeWidth="13" />
        <circle cx="75" cy="75" r={r} fill="none" stroke={colour} strokeWidth="13" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - value / 100)} style={{ transition: 'stroke-dashoffset .8s' }} />
      </svg>
      <div className="val"><div><b>{value}</b><span>{band}</span></div></div>
    </div>
  );
}

/** One bar showing how the five parts add up to the score. */
function Breakdown({ components, score }) {
  return (
    <div>
      <div className="stackbar">
        {components.map((c) => (
          <i key={c.key}
            style={{ width: `${c.contribution}%`, background: COLOURS[c.key] }}
            title={`${c.label} — ${c.contribution} of ${c.max} points`} />
        ))}
        <i className="rest" style={{ width: `${Math.max(0, 100 - score)}%` }} title={`${100 - score} points not earned`} />
      </div>
      <div className="row wrap" style={{ gap: 12, marginTop: 8 }}>
        {components.map((c) => (
          <span key={c.key} className="row tiny muted" style={{ gap: 5 }}>
            <i style={{ width: 8, height: 8, borderRadius: 2, background: COLOURS[c.key], display: 'inline-block' }} />
            {c.label} <span style={{ opacity: 0.7 }}>{c.max}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Trend({ points }) {
  if (!points?.length) return null;
  const w = 460; const h = 150; const pad = 26;
  const xs = (i) => pad + (i * (w - pad * 2)) / Math.max(1, points.length - 1);
  const ys = (v) => h - pad - (v / 100) * (h - pad * 2);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${xs(i)},${ys(p.score)}`).join(' ');
  const area = `${d} L${xs(points.length - 1)},${h - pad} L${xs(0)},${h - pad} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 'auto' }}>
      {[25, 50, 75].map((g) => (
        <line key={g} x1={pad} x2={w - pad} y1={ys(g)} y2={ys(g)} stroke="var(--line-2)" />
      ))}
      <path d={area} fill="var(--green-soft)" />
      <path d={d} fill="none" stroke="var(--green)" strokeWidth="2.5" strokeLinejoin="round" />
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={xs(i)} cy={ys(p.score)} r="3.5" fill="#fff" stroke="var(--green)" strokeWidth="2" />
          {(i === 0 || i === points.length - 1) && (
            <text x={xs(i)} y={ys(p.score) - 10} fontSize="11" fontWeight="600" textAnchor="middle" fill="var(--ink)">{p.score}</text>
          )}
          <text x={xs(i)} y={h - 7} fontSize="9.5" textAnchor="middle" fill="var(--muted)">{i === points.length - 1 ? 'now' : p.week}</text>
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
        <div className="actions">
          <button className="btn primary" onClick={narrate} disabled={busy}>
            {busy ? <><Spinner /> Explaining…</> : '✦ Explain my score'}
          </button>
        </div>
      </div>

      <Card>
        <div className="score-top">
          <Ring value={data.score} band={data.band} />
          <div className="grow stack" style={{ gap: 16 }}>
            <Breakdown components={data.components} score={data.score} />
            <div className="comp-grid">
              {data.components.map((c) => (
                <div key={c.key} className="comp" title={`${c.contribution} of ${c.max} points`}>
                  <div className="row">
                    <span className="grow">{c.label}</span>
                    <b>{c.display}</b>
                  </div>
                  <Bar value={c.value} tone={c.value < 0.35 ? 'red' : c.value < 0.65 ? 'amber' : ''} />
                  <div className="tiny muted">{c.detail}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {(narr || error) && (
        <Card title="What it means" className="mt">
          <ErrorBox error={error} />
          <Degraded note={narr?.degradedNote} />
          {narr && (
            <div className="stack" style={{ gap: 10 }}>
              <b>{narr.narration.headline}</b>
              <div className="small"><span className="chip green">working</span> {narr.narration.what_is_working}</div>
              <div className="small"><span className="chip amber">fix</span> {narr.narration.what_to_fix}</div>
              <div className="banner blue small"><span>→</span><div><b>Next 48 hours:</b> {narr.narration.next_step}</div></div>
              <TraceStrip ids={[narr.traceId]} />
            </div>
          )}
        </Card>
      )}

      <div className="grid-2 mt">
        <Card title="Six weeks">
          <Trend points={data.history} />
        </Card>

        <Card title="Streak milestones" hint="motivational · set by rules">
          <div className="row" style={{ gap: 26, marginBottom: 14 }}>
            <div>
              <div className="tiny muted">CURRENT</div>
              <div style={{ fontSize: 30, fontWeight: 700, lineHeight: 1.1 }}>🔥 {st.current}</div>
            </div>
            <div>
              <div className="tiny muted">NEXT MILESTONE</div>
              <div style={{ fontSize: 30, fontWeight: 700, lineHeight: 1.1 }}>{st.target}</div>
            </div>
            <div className="grow">
              <div className="tiny muted">MILESTONES · {st.band}</div>
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                {st.ladder.map((t) => <span key={t} className={`chip ${t === st.target ? 'green' : ''}`}>{t}d</span>)}
              </div>
            </div>
          </div>
          <Bar value={st.target ? st.current / st.target : 0} />
          <p className="small muted" style={{ marginTop: 10 }}>
            {st.rationale} Separate from the score above, which grades every user out of 21 unbroken days.
          </p>
        </Card>
      </div>
    </>
  );
}
