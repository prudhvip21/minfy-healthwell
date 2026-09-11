import { useEffect, useState } from 'react';
import { Card, Spinner } from '../components.jsx';

const USE_CASES = [
  ['checkin', 'Daily Check-in', 'POST /api/checkin'],
  ['planloop', 'Plan Change Loop', 'POST /api/plan/propose'],
  ['nudges', 'Re-engagement Nudges', 'GET /api/nudges/:user'],
  ['assistant', 'Wellness Assistant', 'POST /api/assistant'],
  ['score', 'Behaviour Score', 'GET /api/score/:user'],
  ['explain', 'Explainable Recs', 'POST /api/explain/:user/:entry'],
];

/** Probes a harmless endpoint per use case to prove the gate is enforced server-side. */
const PROBES = {
  checkin: ['POST', '/api/transcribe', {}],
  planloop: ['GET', '/api/review'],
  nudges: ['GET', '/api/nudges/ananya'],
  assistant: ['POST', '/api/assistant', {}],
  score: ['GET', '/api/score/ananya'],
  explain: ['POST', '/api/explain/ananya/0', {}],
};

export default function Partners() {
  const [partners, setPartners] = useState([]);
  const [probe, setProbe] = useState({});
  const [busy, setBusy] = useState(null);

  const load = () => fetch('/api/partners').then((r) => r.json()).then(setPartners);
  useEffect(() => { load(); }, []);

  async function save(p, patch) {
    await fetch(`/api/partners/${p.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    load();
  }

  async function runProbe(p) {
    setBusy(p.id);
    const out = {};
    for (const [uc, [method, url, body]] of Object.entries(PROBES)) {
      const res = await fetch(url, {
        method,
        headers: { 'x-partner-id': p.id, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      // A 403 means the partner gate refused it. Anything else means the gate let it through
      // (the handler may then 400/404 on the empty probe body — that's the service, not the gate).
      out[uc] = { status: res.status, allowed: res.status !== 403, remaining: res.headers.get('x-ratelimit-remaining') };
      if (res.body) res.body.cancel?.();
    }
    setProbe((s) => ({ ...s, [p.id]: out }));
    setBusy(null);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Partner &amp; White-label Config</h1>
          <p className="sub">Same APIs, configured per partner. Switch partner in the top bar to see it.</p>
        </div>
      </div>

      <div className="stack">
        {partners.map((p) => (
          <Card key={p.id} title={<span className="row"><span style={{ fontSize: 20 }}>{p.brand.logo}</span> {p.name}</span>}
            hint={<span className="row" style={{ gap: 6 }}><span style={{ width: 14, height: 14, borderRadius: 4, background: p.brand.primary, display: 'inline-block' }} /> {p.brand.primary}</span>}>
            <div className="grid-2" style={{ gap: 20 }}>
              <div>
                <div className="tiny strong muted" style={{ marginBottom: 6 }}>EXPOSED USE CASES</div>
                {USE_CASES.map(([id, label, ep]) => {
                  const on = p.enabled.includes(id);
                  const pr = probe[p.id]?.[id];
                  return (
                    <label key={id} className="row" style={{ padding: '5px 0', borderBottom: '1px solid var(--line-2)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={on}
                        onChange={() => save(p, { enabled: on ? p.enabled.filter((x) => x !== id) : [...p.enabled, id] })} />
                      <span className="grow">{label}</span>
                      <code className="muted">{ep}</code>
                      {pr && <span className={`chip ${pr.allowed ? 'green' : 'red'}`}>{pr.allowed ? 'gate: open' : '403'}</span>}
                    </label>
                  );
                })}
              </div>
              <div className="stack" style={{ gap: 12 }}>
                <div>
                  <div className="tiny strong muted" style={{ marginBottom: 6 }}>RATE LIMIT (requests / min)</div>
                  <input className="input" type="number" defaultValue={p.rate_limit} style={{ width: 140 }}
                    onBlur={(e) => Number(e.target.value) !== p.rate_limit && save(p, { rate_limit: Number(e.target.value) })} />
                </div>
                <div>
                  <button className="btn" onClick={() => runProbe(p)} disabled={busy === p.id}>
                    {busy === p.id ? <Spinner /> : '⚡'} Probe API as {p.name.split(' ')[0]}
                  </button>
                  {probe[p.id] && (
                    <div className="small muted" style={{ marginTop: 6 }}>
                      <code>x-partner-id: {p.id}</code> · {Object.values(probe[p.id]).at(-1)?.remaining ?? '—'} left this minute
                    </div>
                  )}
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
