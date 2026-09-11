import { useCallback, useEffect, useState } from 'react';
import { api, setPartner } from './api.js';
import { Spinner } from './components.jsx';

import Overview from './screens/Overview.jsx';
import CheckIn from './screens/CheckIn.jsx';
import PlanLoop from './screens/PlanLoop.jsx';
import Nudges from './screens/Nudges.jsx';
import Assistant from './screens/Assistant.jsx';
import Score from './screens/Score.jsx';
import Explain from './screens/Explain.jsx';
import Review from './screens/Review.jsx';
import Traces from './screens/Traces.jsx';
import Partners from './screens/Partners.jsx';

const NAV = [
  { group: 'Platform 2.0', items: [
    { id: 'overview', label: 'Overview', ico: '◎' },
  ] },
  { group: 'Phase 1 · Engagement', items: [
    { id: 'checkin', label: 'Daily Check-in', ico: '📸', uc: 'checkin', n: 1 },
    { id: 'planloop', label: 'Plan Change Loop', ico: '🔁', uc: 'planloop', n: 2 },
    { id: 'nudges', label: 'Re-engagement', ico: '🔔', uc: 'nudges', n: 3 },
    { id: 'assistant', label: 'Wellness Assistant', ico: '💬', uc: 'assistant', n: 4 },
    { id: 'score', label: 'Behaviour Score', ico: '📈', uc: 'score', n: 5 },
  ] },
  { group: 'Phase 2', items: [
    { id: 'explain', label: 'Explainable Recs', ico: '🔍', uc: 'explain', n: 6 },
  ] },
  { group: 'Governance', items: [
    { id: 'review', label: 'Dietitian Queue', ico: '🩺', badge: true },
    { id: 'traces', label: 'Trace Console', ico: '🧾' },
    { id: 'partners', label: 'Partner Config', ico: '🤝' },
  ] },
];

const SCREENS = { overview: Overview, checkin: CheckIn, planloop: PlanLoop, nudges: Nudges, assistant: Assistant, score: Score, explain: Explain, review: Review, traces: Traces, partners: Partners };

function initialScreen() {
  const h = window.location.hash.replace('#', '');
  return SCREENS[h] ? h : 'overview';
}

export default function App() {
  const [screen, setScreen] = useState(initialScreen);
  const [users, setUsers] = useState([]);
  const [userId, setUserId] = useState(() => localStorage.getItem('hw.user') || 'ananya');
  const [health, setHealth] = useState(null);
  const [partners, setPartners] = useState([]);
  const [partnerId, setPartnerId] = useState('healthwise');
  const [resetting, setResetting] = useState(false);
  const [tick, setTick] = useState(0);        // bump to make screens refetch

  const refresh = useCallback(() => {
    api.get('/api/users').then(setUsers).catch(() => {});
    api.get('/api/health').then(setHealth).catch(() => setHealth({ ok: false }));
  }, []);

  useEffect(() => { refresh(); api.get('/api/partners').then(setPartners).catch(() => {}); }, [refresh, tick]);
  useEffect(() => { window.location.hash = screen; }, [screen]);
  useEffect(() => { localStorage.setItem('hw.user', userId); }, [userId]);

  const partner = partners.find((p) => p.id === partnerId);
  const enabled = partner?.enabled || null;

  useEffect(() => {
    setPartner(partnerId);
    const brand = partner?.brand?.primary;
    const root = document.documentElement.style;
    if (brand && partnerId !== 'healthwise') {
      root.setProperty('--green', brand);
      root.setProperty('--green-dark', brand);
    } else {
      root.removeProperty('--green');
      root.removeProperty('--green-dark');
    }
  }, [partnerId, partner]);

  const user = users.find((u) => u.id === userId) || users[0];
  const pending = users.reduce((t, u) => t + (u.pendingReviews || 0), 0);

  const bump = () => { setTick((t) => t + 1); };

  async function reset() {
    if (!confirm('Reset all demo state? Check-ins, proposals, nudges and traces are cleared. Parsed plans are kept.')) return;
    setResetting(true);
    try { await api.post('/api/reset'); bump(); } finally { setResetting(false); }
  }

  const Screen = SCREENS[screen];
  const screenUc = NAV.flatMap((g) => g.items).find((i) => i.id === screen)?.uc;
  const blocked = enabled && screenUc && !enabled.includes(screenUc);

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <div className="brand-mark">{partner && partnerId !== 'healthwise' ? partner.brand.logo : 'H'}</div>
          <div>
            <b>{partner && partnerId !== 'healthwise' ? partner.name.split(' (')[0] : 'HealthWise'}</b>
            <span>Platform 2.0 prototype</span>
          </div>
        </div>

        {NAV.map((g) => (
          <div className="nav-group" key={g.group}>
            <div className="nav-label">{g.group}</div>
            {g.items.map((i) => {
              const off = enabled && i.uc && !enabled.includes(i.uc);
              return (
                <button
                  key={i.id}
                  className={`nav-item ${screen === i.id ? 'on' : ''}`}
                  onClick={() => setScreen(i.id)}
                  style={off ? { opacity: 0.4 } : undefined}
                  title={off ? `Not enabled for ${partner.name}` : undefined}
                >
                  <span className="ico">{i.ico}</span>
                  {i.label}
                  {i.badge && pending > 0 ? <span className="badge">{pending}</span>
                    : i.n ? <span className="num">#{i.n}</span> : null}
                </button>
              );
            })}
          </div>
        ))}

        <div className="side-foot">
          <div className="row" style={{ gap: 6 }}>
            <span className={`status-dot ${health?.hasKey ? '' : 'error'}`} />
            {health?.hasKey ? `${health.models.reason} · ${health.models.transcribe}` : 'OPENAI_API_KEY missing'}
          </div>
          <div style={{ marginTop: 4 }}>Rules engine decides · AI proposes</div>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div className="users">
            {users.map((u) => (
              <button key={u.id} className={`user-pill ${u.id === user?.id ? 'on' : ''}`} onClick={() => setUserId(u.id)}>
                <span className="av">{u.avatar}</span>
                <span style={{ textAlign: 'left' }}>
                  <b>{u.name.split(' ')[0]}</b>
                  <small>{u.score} · {u.band}</small>
                </span>
              </button>
            ))}
          </div>
          <div className="spacer" />
          <select className="select" style={{ width: 'auto' }} value={partnerId} onChange={(e) => setPartnerId(e.target.value)} title="Serve the app as a partner">
            {partners.map((p) => <option key={p.id} value={p.id}>{p.brand?.logo} {p.name}</option>)}
          </select>
          <button className="btn sm" onClick={reset} disabled={resetting}>
            {resetting ? <Spinner /> : '↺'} Reset demo
          </button>
        </div>

        <div className="content">
          {health && !health.hasKey && (
            <div className="banner amber" style={{ marginBottom: 16 }}>
              <span>⚠</span>
              <div><b>No OpenAI key.</b> Add <code>OPENAI_API_KEY</code> to <code>.env</code> and restart.</div>
            </div>
          )}
          {blocked ? (
            <div className="card card-pad" style={{ maxWidth: 560 }}>
              <h2>Not enabled for {partner.name}</h2>
              <p className="muted" style={{ marginTop: 6 }}>The API returns <code>403</code>. Enable it in Partner Config — no deploy needed.</p>
              <button className="btn" style={{ marginTop: 12 }} onClick={() => setScreen('partners')}>Open Partner Config</button>
            </div>
          ) : user ? (
            <Screen key={`${screen}-${user.id}-${tick}`} user={user} users={users} onChange={refresh} go={setScreen} setUserId={setUserId} />
          ) : (
            <div className="empty"><Spinner /> Loading…</div>
          )}
        </div>
      </main>
    </div>
  );
}
