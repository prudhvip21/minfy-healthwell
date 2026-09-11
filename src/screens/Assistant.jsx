import { useEffect, useRef, useState } from 'react';
import { stream } from '../api.js';
import { Card, Lane, Spinner, TraceStrip } from '../components.jsx';

const PROMPTS = {
  ananya: ['How am I doing this week?', 'Can I have peanut chikki as a snack?', 'Why is there ghee in so many meals?'],
  rohit: ['I had chicken biryani for lunch at a client meeting', "What's left in my plan today?", 'How much protein have I had today?'],
  meera: ["I've been away for a few days — where do I start?", 'Is raitha OK for me?', 'What should I eat for dinner tonight?'],
};

export default function Assistant({ user, onChange }) {
  const [log, setLog] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [prevId, setPrevId] = useState(null);
  const [traceIds, setTraceIds] = useState([]);
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [log]);

  async function send(message) {
    if (!message.trim() || busy) return;
    setBusy(true);
    setText('');
    setLog((l) => [...l, { role: 'user', text: message }, { role: 'bot', text: '', streaming: true }]);

    const appendBot = (fn) => setLog((l) => {
      const copy = [...l];
      for (let i = copy.length - 1; i >= 0; i -= 1) {
        if (copy[i].role === 'bot') { copy[i] = fn(copy[i]); break; }
      }
      return copy;
    });

    try {
      await stream('/api/assistant', { userId: user.id, message, previousResponseId: prevId }, (ev, data) => {
        if (ev === 'delta') appendBot((b) => ({ ...b, text: b.text + data.text }));
        if (ev === 'tool') {
          // Tool calls appear above the answer as it forms.
          setLog((l) => {
            const copy = [...l];
            const botIdx = copy.map((m) => m.role).lastIndexOf('bot');
            copy.splice(botIdx, 0, { role: 'tool', text: `→ ${data.name}(${Object.keys(data.args).length ? JSON.stringify(data.args) : ''})` });
            return copy;
          });
        }
        if (ev === 'result') {
          setLog((l) => {
            const copy = [...l];
            for (let i = copy.length - 1; i >= 0; i -= 1) {
              if (copy[i].role === 'tool' && copy[i].text.includes(data.name) && !copy[i].done) {
                const r = data.result;
                const brief = r?.decision ? ` ✓ ${r.decision}` : r?.error ? ` ✕ ${r.error}` : Array.isArray(r) ? ` ✓ ${r.length} rows` : ' ✓';
                copy[i] = { ...copy[i], text: copy[i].text + brief, done: true };
                break;
              }
            }
            return copy;
          });
        }
        if (ev === 'guardrail') setLog((l) => [...l.slice(0, -1), { role: 'tool', text: `guardrail: ${data.note}` }, l[l.length - 1]]);
        if (ev === 'degraded') appendBot((b) => ({ ...b, text: data.text, degraded: data.note }));
        if (ev === 'error') appendBot((b) => ({ ...b, text: `⚠ ${data.message}`, error: true }));
        if (ev === 'done') {
          if (data.responseId) setPrevId(data.responseId);
          setTraceIds((t) => [...data.traceIds, ...t].slice(0, 12));
        }
      });
    } catch (e) {
      appendBot((b) => ({ ...b, text: `⚠ ${e.message}`, error: true }));
    } finally {
      appendBot((b) => ({ ...b, streaming: false }));
      setBusy(false);
      onChange?.();
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Digital Wellness Assistant</h1>
          <p className="sub">One chat over every agent. Tools, memory — no write access to the plan.</p>
        </div>
        <div className="actions">
          <button className="btn sm" onClick={() => { setLog([]); setPrevId(null); setTraceIds([]); }}>New conversation</button>
        </div>
      </div>

      <div className="split">
        <div>
          <Lane kind="user" />
          <div className="card chat">
            <div className="chat-log">
              {log.length === 0 && (
                <div className="empty">
                  <div style={{ fontSize: 30 }}>{user.avatar}</div>
                  Ask anything about your plan.
                </div>
              )}
              {log.map((m, i) => (
                <div key={i} className={`msg ${m.role}`} style={m.error ? { background: 'var(--red-soft)', color: '#8f1f23' } : undefined}>
                  {m.text || (m.streaming ? <Spinner /> : '')}
                  {m.degraded && <div className="tiny" style={{ marginTop: 6, color: '#9a6200' }}>⚠ {m.degraded}</div>}
                </div>
              ))}
              <div ref={endRef} />
            </div>
            <div className="suggest">
              {(PROMPTS[user.id] || []).map((p) => (
                <button key={p} className="chip" style={{ border: 0, cursor: 'pointer' }} disabled={busy} onClick={() => send(p)}>{p}</button>
              ))}
            </div>
            <div className="chat-input">
              <input className="input" placeholder={`Message as ${user.name.split(' ')[0]}…`} value={text}
                onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send(text)} disabled={busy} />
              <button className="btn primary" onClick={() => send(text)} disabled={busy || !text.trim()}>{busy ? <Spinner /> : 'Send'}</button>
            </div>
          </div>
        </div>

        <div className="stack">
          <Lane kind="system" />
          <Card title="Tools">
            <div className="stack small" style={{ gap: 6 }}>
              {[
                ['get_plan · get_day_totals · get_progress', 'rule'],
                ['get_recent_checkins', 'rule'],
                ['check_food — allergy gate', 'rule'],
                ['log_meal → Logging agent', 'ai'],
                ['propose_plan_change → Swap agent', 'ai'],
              ].map(([n, k]) => (
                <div key={n} className="row">
                  <span className={`chip ${k === 'ai' ? 'violet' : 'green'}`}>{k === 'ai' ? 'agent' : 'engine'}</span>
                  <code>{n}</code>
                </div>
              ))}
            </div>
          </Card>
          <Card>{traceIds.length ? <TraceStrip ids={traceIds} title="This session" /> : <div className="small muted">Calls appear here as you chat.</div>}</Card>
        </div>
      </div>
    </>
  );
}
