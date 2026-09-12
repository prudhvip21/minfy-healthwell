import { useRef, useState } from 'react';
import { fileToDataUrl, shrinkImage, blobToBase64 } from './api.js';
import { Spinner, slotsFor } from './components.jsx';

const SLOT_LABEL = { 'Wake up': 'Wake up', Breakfast: 'Breakfast', 'Mid-Morning': 'Mid-morning', Lunch: 'Lunch', Snack: 'Snack', 'Post Exercise': 'Post-exercise', Dinner: 'Dinner', 'Post Dinner': 'Post-dinner' };

function minutes(hint) {
  const m = /(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(hint || '');
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if ((m[3] || '').toLowerCase() === 'pm') h += 12;
  return h * 60 + Number(m[2]);
}

/** The meal happening now: the latest slot that has started, allowing an hour's grace. */
function currentSlot(slots) {
  const now = new Date().getHours() * 60 + new Date().getMinutes();
  let pick = slots[0]?.slot;
  for (const s of slots) {
    const t = minutes(s.time);
    if (t !== null && t <= now + 60) pick = s.slot;
  }
  return pick;
}

/** Meal-slot picker, with each slot's progress for today. */
function SlotBar({ slots, value, onChange, disabled }) {
  return (
    <div className="slotbar">
      {slots.map((s) => {
        const state = s.total && s.done >= s.total ? 'done' : s.done > 0 ? 'part' : '';
        return (
          <button key={s.slot} className={`slot-pill ${value === s.slot ? 'on' : ''} ${state}`}
            onClick={() => onChange(s.slot)} disabled={disabled} title={`${s.done}/${s.total} logged${s.time ? ` · ${s.time}` : ''}`}>
            <i />{SLOT_LABEL[s.slot] || s.slot}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Photo / voice / text meal capture. Shared by Daily Check-in and the Plan
 * Change Loop — one way in for every meal, however it is reported.
 * onSubmit receives { slot, modality, text, imageDataUrl, audioBase64, mime, seconds }.
 * `slots` is today's plan by slot: [{ slot, time, done, total }].
 */
export default function MealInput({ onSubmit, busy, samples = [], plan = null, submitLabel = 'Log meal', busyLabel = 'Checking…' }) {
  const slots = slotsFor(plan);
  const [slot, setSlot] = useState(null);
  const activeSlot = slot || currentSlot(slots);
  const [mode, setMode] = useState('menu');
  const [picked, setPicked] = useState({});
  const [extras, setExtras] = useState('');
  const [text, setText] = useState('');
  const [image, setImage] = useState(null);
  const [recording, setRecording] = useState(false);
  const [audio, setAudio] = useState(null);
  const [micError, setMicError] = useState(null);
  const recRef = useRef(null);
  const startRef = useRef(0);
  const fileRef = useRef(null);

  async function onFile(f) {
    if (!f) return;
    setImage(await shrinkImage(await fileToDataUrl(f)));
  }

  async function startRec() {
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
      const rec = new MediaRecorder(stream, { mimeType: mime });
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: mime });
        setAudio({ blob, mime, seconds: Math.round((Date.now() - startRef.current) / 100) / 10, url: URL.createObjectURL(blob) });
      };
      recRef.current = rec;
      startRef.current = Date.now();
      rec.start();
      setRecording(true);
      setAudio(null);
    } catch (e) {
      setMicError(`Microphone unavailable: ${e.message}`);
    }
  }

  function stopRec() {
    recRef.current?.stop();
    setRecording(false);
  }

  async function submit() {
    const payload = { modality: mode, slot: activeSlot || null };
    if (mode === 'menu') {
      payload.entryIds = Object.keys(picked).filter((id) => picked[id]).map(Number);
      payload.extras = extras;
    }
    if (mode === 'photo') { payload.imageDataUrl = image; payload.text = text; }
    if (mode === 'text') payload.text = text;
    if (mode === 'voice') {
      payload.audioBase64 = await blobToBase64(audio.blob);
      payload.mime = audio.mime;
      payload.seconds = audio.seconds;
    }
    onSubmit(payload);
  }

  const slotItems = (plan?.slots || []).find((s) => s.slot === activeSlot)?.items || [];
  const menuItems = slotItems.filter((i) => i.status !== 'swapped');
  const pickedCount = Object.values(picked).filter(Boolean).length;

  const ready = !busy && (
    (mode === 'menu' && (pickedCount > 0 || extras.trim()))
    || (mode === 'photo' && image) || (mode === 'text' && text.trim()) || (mode === 'voice' && audio));

  return (
    <div className="stack">
      {slots.length > 0 && <SlotBar slots={slots} value={activeSlot} onChange={setSlot} disabled={busy} />}
      <div className="tabs spread">
        {[['menu', '☑ Menu'], ['photo', '📸 Photo'], ['voice', '🎙 Voice'], ['text', '⌨ Text']].map(([k, l]) => (
          <button key={k} className={`tab ${mode === k ? 'on' : ''}`} onClick={() => setMode(k)} disabled={busy}>{l}</button>
        ))}
      </div>

      {mode === 'menu' && (
        <div className="stack" style={{ gap: 10 }}>
          {menuItems.length === 0 && <div className="small muted center">Nothing planned for this meal.</div>}
          {menuItems.map((i) => {
            const done = i.status === 'eaten' || i.status === 'offplan';
            return (
              <label key={i.id} className={`pick ${done ? 'done' : ''} ${picked[i.id] ? 'on' : ''}`}>
                <input type="checkbox" disabled={done || busy}
                  checked={done || Boolean(picked[i.id])}
                  onChange={(e) => setPicked((p) => ({ ...p, [i.id]: e.target.checked }))} />
                <span className="grow">{i.name}</span>
                <span className="tiny muted">{i.qty ?? ''} {i.unit || ''}</span>
                {done && <span className="tiny" style={{ color: i.status === 'offplan' ? '#c2491a' : 'var(--green-dark)' }}>{i.status === 'offplan' ? 'off-plan' : 'logged'}</span>}
              </label>
            );
          })}
          <input className="input" placeholder="Anything extra? e.g. 2 samosas, a coffee"
            value={extras} onChange={(e) => setExtras(e.target.value)} disabled={busy} />
        </div>
      )}

      {mode === 'photo' && (
        <>
          <div className="drop" onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files[0]); }}>
            {image ? <img src={image} alt="meal" /> : (
              <>
                <div style={{ fontSize: 28 }}>📷</div>
                <div className="strong">Snap or drop a photo</div>
              </>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onFile(e.target.files[0])} />
          <input className="input" placeholder="Add a note (optional)" value={text} onChange={(e) => setText(e.target.value)} />
        </>
      )}

      {mode === 'voice' && (
        <div className="stack center" style={{ gap: 10 }}>
          <button className={`btn ${recording ? 'rec' : 'primary'}`} style={{ padding: '14px 22px', borderRadius: 99 }}
            onClick={recording ? stopRec : startRec} disabled={busy}>
            {recording ? <><span className="rec-dot" /> Stop</> : '🎙 Tap to record'}
          </button>
          {audio && <audio controls src={audio.url} style={{ width: '100%' }} />}
          {micError && <span className="small" style={{ color: 'var(--red)' }}>{micError}</span>}
        </div>
      )}

      {mode === 'text' && (
        <>
          <textarea className="textarea" placeholder="e.g. 2 rotis and dal for lunch" value={text} onChange={(e) => setText(e.target.value)} />
          {samples.length > 0 && (
            <div className="row wrap" style={{ gap: 6 }}>
              {samples.map((s) => (
                <button key={s} className="chip" style={{ border: 0, cursor: 'pointer' }} onClick={() => setText(s)}>{s}</button>
              ))}
            </div>
          )}
        </>
      )}

      <button className="btn primary" disabled={!ready} onClick={submit}>
        {busy ? <><Spinner /> {busyLabel}</> : `${submitLabel}${activeSlot ? ` · ${SLOT_LABEL[activeSlot] || activeSlot}` : ''}`}
      </button>
    </div>
  );
}
