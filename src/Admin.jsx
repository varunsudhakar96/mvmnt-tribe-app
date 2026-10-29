import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  adminListRuns, adminSaveRun, adminDeleteRun, adminNewQr, adminAddAttendee, adminRemoveAttendee, uploadPoster, normalisePhone,
  checkinLink, messageFor, runDate, runTime,
} from './api.js';
import { go, href } from './router.js';
import { answerText, ShareButton } from './Runs.jsx';

const LAST_KM = 'mvmnt.lastRunKm';
const remember = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const recall = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };

function AdminBar({ back = '', label = '‹ Home' }) {
  return (
    <header className="topbar">
      <a className="link back" href={href(back)}>{label}</a>
      <span className="admin-tag">Organiser</span>
    </header>
  );
}

// ---------- List ----------
export function AdminRuns() {
  const [runs, setRuns] = useState(undefined);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try { setRuns(await adminListRuns()); } catch (e) { setError(messageFor(e.code)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const upcoming = (runs || []).filter((r) => !r.is_past).reverse();
  const past = (runs || []).filter((r) => r.is_past);

  return (
    <main className="shell">
      <AdminBar />
      <div className="stack">
        <h1 className="display">Runs</h1>
        <a className="btn" href={href('admin/run/new')}>Add a run</a>
        {error && <p className="error" role="alert">{error}</p>}
        {!error && runs === undefined && <p className="muted">Loading…</p>}
        {runs && (
          <>
            <AdminGroup title="Upcoming" runs={upcoming} empty="Nothing scheduled. Add the next run." />
            {past.length > 0 && <AdminGroup title="Past" runs={past.slice(0, 12)} />}
          </>
        )}
      </div>
    </main>
  );
}

function AdminGroup({ title, runs, empty }) {
  return (
    <section aria-label={title}>
      <h2 className="section-title">{title}</h2>
      {runs.length === 0 && <p className="muted">{empty}</p>}
      <ul className="admin-list">
        {runs.map((r) => (
          <li key={r.id}>
            <a href={href(`admin/run/${r.id}`)}>
              <span>
                <span className="run-name">{r.name}</span>
                <span className="muted">
                  {[runDate(r.date), runTime(r.time), r.venue].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className="flags">
                {r.is_today && <span className="today">Today</span>}
                {r.signup_count > 0 && <span className="count">{r.signup_count} signed up</span>}
                {r.attendees?.length > 0 && <span className="count">{r.attendees.length} ran</span>}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- Add / edit ----------
const EMPTY = { name: '', date: '', time: '06:00', venue: '', map_url: '', description: '', run_km: '5', poster_url: '',
  signup_enabled: true, signup_fields: [], capacity: '' };
const LAST_FIELDS = 'mvmnt.lastSignupFields';
const lastFields = () => { try { return JSON.parse(recall(LAST_FIELDS) || '[]').map((f) => ({ ...f, id: newId() })); } catch { return []; } };
const newId = () => `f_${Math.random().toString(36).slice(2, 10)}`;

export function AdminRunEdit({ id }) {
  const isNew = id === 'new';
  const [form, setForm] = useState(isNew ? { ...EMPTY, run_km: recall(LAST_KM) || '5', signup_fields: lastFields() } : null);
  const [saved, setSaved] = useState(null); // the run as stored (has the QR code)
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    if (isNew) return;
    adminListRuns()
      .then((all) => {
        const r = all.find((x) => x.id === id);
        if (!r) { setError(messageFor('run_not_found')); return; }
        setSaved(r);
        setForm({ ...EMPTY, ...Object.fromEntries(Object.keys(EMPTY).map((k) => [k, r[k] ?? ''])) });
      })
      .catch((e) => setError(messageFor(e.code)));
  }, [id, isNew]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function pickPoster(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(''); setBusy('poster');
    try {
      const url = await uploadPoster(file);
      setForm((f) => ({ ...f, poster_url: url }));
    } catch (err) {
      setError(messageFor(err.code));
    } finally {
      setBusy('');
    }
  }

  async function save(e) {
    e.preventDefault();
    setError(''); setNotice(''); setBusy('save');
    try {
      const r = await adminSaveRun({ ...form, id: isNew ? null : id });
      if (r.run_km) remember(LAST_KM, String(r.run_km));
      remember(LAST_FIELDS, JSON.stringify(r.signup_fields || []));
      setForm((f) => ({ ...f, signup_fields: r.signup_fields || [] }));
      setSaved(r);
      if (isNew) { go(`admin/run/${r.id}`); }
      setNotice('Saved. Members can see it now.');
    } catch (err) {
      setError(messageFor(err.code));
    } finally {
      setBusy('');
    }
  }

  async function remove() {
    setBusy('delete');
    try { await adminDeleteRun(id); go('admin'); } catch (err) { setError(messageFor(err.code)); setBusy(''); }
  }

  if (!form) {
    return (
      <main className="shell">
        <AdminBar back="admin" label="‹ Runs" />
        {error ? <p className="error" role="alert">{error}</p> : <p className="muted">Loading…</p>}
      </main>
    );
  }

  return (
    <main className="shell">
      <AdminBar back="admin" label="‹ Runs" />
      <form className="stack" onSubmit={save} noValidate>
        <div className="title-row">
          <h1 className="display">{isNew ? 'New run' : 'Edit run'}</h1>
          {!isNew && saved && <ShareButton run={saved} />}
        </div>

        <div className="field">
          <span className="label">Poster</span>
          <button type="button" className={`poster-pick${form.poster_url ? ' has' : ''}`}
                  onClick={() => fileRef.current?.click()} disabled={busy === 'poster'}>
            {form.poster_url
              ? <img src={form.poster_url} alt="Run poster" />
              : <span>{busy === 'poster' ? 'Uploading…' : 'Add the run poster'}</span>}
          </button>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={pickPoster} />
          {form.poster_url && (
            <div className="row">
              <button type="button" className="link inline" onClick={() => fileRef.current?.click()}>
                {busy === 'poster' ? 'Uploading…' : 'Change poster'}
              </button>
              <button type="button" className="link inline" onClick={() => setForm((f) => ({ ...f, poster_url: '' }))}>
                Remove
              </button>
            </div>
          )}
        </div>

        <Field label="Run name" required>
          <input className="input" value={form.name} onChange={set('name')} placeholder="Saturday 5K" required />
        </Field>
        <div className="two">
          <Field label="Date" required>
            <input className="input" type="date" value={form.date} onChange={set('date')} required />
          </Field>
          <Field label="Start time">
            <input className="input" type="time" value={form.time} onChange={set('time')} />
          </Field>
        </div>
        <Field label="Venue">
          <input className="input" value={form.venue} onChange={set('venue')} placeholder="Race Course, Coimbatore" />
        </Field>
        <Field label="Location link" hint="Paste the Google Maps share link.">
          <input className="input" type="url" inputMode="url" value={form.map_url} onChange={set('map_url')} placeholder="https://maps.app.goo.gl/…" />
        </Field>
        <Field label="Details" hint="Optional: route, distance, what to bring.">
          <textarea className="input area" rows={3} value={form.description} onChange={set('description')} />
        </Field>
        <SignupBuilder form={form} setForm={setForm} hasSignups={(saved?.signup_count || 0) > 0} />

        <Field label="Distance (km)" hint="What a QR check-in logs by default. Runners can change it if they ran more or less.">
          <input className="input" inputMode="decimal" value={form.run_km ?? ''} placeholder="5"
                 onChange={(e) => setForm((f) => ({ ...f, run_km: e.target.value.replace(/[^0-9.]/g, '').slice(0, 5) }))} />
        </Field>

        {error && <p className="error" role="alert">{error}</p>}
        {notice && !error && <p className="saved" role="status">{notice}</p>}
        <button className="btn" type="submit" disabled={!!busy}>
          {busy === 'save' ? 'Saving…' : isNew ? 'Publish run' : 'Save changes'}
        </button>
      </form>

      {!isNew && saved && <Attendance run={saved} onChange={setSaved} />}
      {!isNew && saved && <Signups run={saved} />}
      {!isNew && saved && <VenueQr run={saved} onChange={setSaved} />}

      {!isNew && (
        <section className="danger-zone">
          {!confirmDelete ? (
            <button className="link" onClick={() => setConfirmDelete(true)}>Delete this run</button>
          ) : (
            <div className="stack">
              <p className="muted">Remove “{form.name}” from the app? Members won't see it any more.</p>
              <button className="btn danger" onClick={remove} disabled={busy === 'delete'}>
                {busy === 'delete' ? 'Deleting…' : 'Yes, delete it'}
              </button>
              <button className="btn ghost" onClick={() => setConfirmDelete(false)}>Keep it</button>
            </div>
          )}
        </section>
      )}
    </main>
  );
}

function Field({ label, hint, required, children }) {
  return (
    <label className="field">
      <span className="label">{label}{required && <span className="req"> *</span>}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

// ---------- Sign-up form builder ----------
const TYPES = [
  ['text', 'Short answer'],
  ['long_text', 'Paragraph'],
  ['number', 'Number'],
  ['choice', 'Single choice'],
  ['checkboxes', 'Checkboxes'],
  ['yes_no', 'Yes / No'],
];

function SignupBuilder({ form, setForm, hasSignups }) {
  const fields = form.signup_fields || [];
  const setFields = (fn) => setForm((f) => ({ ...f, signup_fields: fn(f.signup_fields || []) }));
  const update = (i, patch) => setFields((fs) => fs.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const move = (i, d) => setFields((fs) => {
    const a = [...fs]; const j = i + d;
    if (j < 0 || j >= a.length) return a;
    [a[i], a[j]] = [a[j], a[i]]; return a;
  });

  return (
    <section className="builder" aria-labelledby="b-title">
      <div className="builder-head">
        <h2 className="section-title" id="b-title">Sign-up form</h2>
        <label className="toggle">
          <input type="checkbox" checked={!!form.signup_enabled}
                 onChange={(e) => setForm((f) => ({ ...f, signup_enabled: e.target.checked }))} />
          <span>{form.signup_enabled ? 'Open' : 'Closed'}</span>
        </label>
      </div>
      {form.signup_enabled ? (
        <>
          <p className="hint">Runners log in to sign up, so their <strong>name and number</strong> come with every sign-up. Add anything else you need below.</p>
          <label className="field">
            <span className="label">Spots</span>
            <input className="input" inputMode="numeric" value={form.capacity ?? ''} placeholder="No limit"
                   onChange={(e) => setForm((f) => ({ ...f, capacity: e.target.value.replace(/\D/g, '').slice(0, 4) }))} />
            <span className="hint">Sign-ups stop when it's full. Leave empty for no limit.</span>
          </label>

          {fields.map((q, i) => (
            <div className="q-card" key={q.id}>
              <div className="q-top">
                <span className="q-num">Q{i + 1}</span>
                <span className="q-tools">
                  <button type="button" className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                  <button type="button" className="icon-btn" onClick={() => move(i, 1)} disabled={i === fields.length - 1} aria-label="Move down">↓</button>
                  <button type="button" className="icon-btn" onClick={() => setFields((fs) => fs.filter((_, k) => k !== i))} aria-label="Remove question">✕</button>
                </span>
              </div>
              <input className="input" value={q.label} placeholder="Question, e.g. T-shirt size"
                     onChange={(e) => update(i, { label: e.target.value })} aria-label={`Question ${i + 1}`} />
              <div className="q-row">
                <select className="input" value={q.type} onChange={(e) => update(i, { type: e.target.value })} aria-label="Answer type">
                  {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <label className="check">
                  <input type="checkbox" checked={!!q.required} onChange={(e) => update(i, { required: e.target.checked })} />
                  <span>Required</span>
                </label>
              </div>
              {(q.type === 'choice' || q.type === 'checkboxes') && (
                <label className="field">
                  <span className="hint">Options, one per line · {q.type === 'checkboxes' ? 'runners can tick several' : 'runners pick one'}</span>
                  <textarea className="input area" rows={3} value={(q.options || []).join('\n')}
                            placeholder={'S\nM\nL'}
                            onChange={(e) => update(i, { options: e.target.value.split('\n') })} />
                </label>
              )}
            </div>
          ))}
          <button type="button" className="btn ghost" onClick={() => setFields((fs) => [...fs, { id: newId(), label: '', type: 'text', required: false, options: [] }])}>
            + Add a question
          </button>
          {hasSignups && fields.length > 0 && (
            <p className="hint">People have already signed up. If you add a required question now, they won't be asked again; their earlier answers stay.</p>
          )}
        </>
      ) : (
        <p className="hint">The Sign up button is hidden. People already signed up stay signed up.</p>
      )}
    </section>
  );
}

// ---------- Who ran ----------
function Attendance({ run, onChange }) {
  const list = run.attendees || [];
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [km, setKm] = useState('');
  const [needName, setNeedName] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);

  async function add(e) {
    e.preventDefault();
    const p = normalisePhone(phone);
    if (!p) { setError(messageFor('invalid_phone')); return; }
    setBusy('add'); setError('');
    try {
      onChange(await adminAddAttendee(run.id, p, km ? Number(km) : null, name));
      setPhone(''); setName(''); setKm(''); setNeedName(false); setAdding(false);
    } catch (err) {
      if (err.code === 'name_needed') setNeedName(true);
      setError(messageFor(err.code));
    } finally { setBusy(''); }
  }
  async function remove(m) {
    setBusy(m); setError('');
    try { onChange(await adminRemoveAttendee(run.id, m)); } catch (err) { setError(messageFor(err.code)); } finally { setBusy(''); }
  }

  return (
    <section className="signups" aria-labelledby="att-title">
      <h2 className="section-title" id="att-title">Checked in · {list.length}</h2>
      {list.length === 0 && <p className="muted">{run.is_past || run.is_today ? 'Nobody has checked in.' : 'Check-ins open on run day.'}</p>}
      {list.length > 0 && (
        <ol className="su-list">
          {list.map((p) => (
            <li key={p.member_id}>
              <div className="su-row">
                <span>{p.name}{p.by === 'admin check-in' && <span className="muted"> · added by you</span>}</span>
                <span className="att-right">
                  <strong className="tabular">{Number(p.km)} km</strong>
                  <button className="link inline" onClick={() => remove(p.member_id)} disabled={busy === p.member_id}
                          aria-label={`Remove ${p.name}`}>Remove</button>
                </span>
              </div>
              <span className="muted small">{p.phone}</span>
            </li>
          ))}
        </ol>
      )}
      {!adding ? (
        <button className="btn ghost" onClick={() => setAdding(true)}>+ Add someone who couldn't scan</button>
      ) : (
        <form className="stack add-att" onSubmit={add} noValidate>
          <label className="field">
            <span className="label">Their number</span>
            <input className="input" type="tel" inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="98765 43210" />
          </label>
          {needName && (
            <label className="field">
              <span className="label">Their name</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          )}
          <label className="field">
            <span className="label">Distance (km)</span>
            <input className="input" inputMode="decimal" value={km} placeholder={String(run.run_km ?? 5)}
                   onChange={(e) => setKm(e.target.value.replace(/[^0-9.]/g, '').slice(0, 5))} />
          </label>
          <button className="btn" type="submit" disabled={busy === 'add'}>{busy === 'add' ? 'Adding…' : 'Add to this run'}</button>
          <button type="button" className="link" onClick={() => { setAdding(false); setError(''); setNeedName(false); }}>Cancel</button>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

// ---------- Who has signed up ----------
function Signups({ run }) {
  const list = run.signups || [];
  const fields = run.signup_fields || [];

  function downloadCsv() {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const ran = Object.fromEntries((run.attendees || []).map((a) => [a.phone, a.km]));
    const head = ['Name', 'Number', 'Signed up at', 'Checked in (km)', ...fields.map((f) => f.label)];
    const rows = list.map((p) => [p.name, p.phone, new Date(p.at).toLocaleString('en-IN'), ran[p.phone] ?? '', ...fields.map((f) => answerText(p.answers?.[f.id]))]);
    const csv = [head, ...rows].map((r) => r.map(esc).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = `signups-${run.date}-${run.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`;
    a.click();
  }

  return (
    <section className="signups" aria-labelledby="su-title">
      <h2 className="section-title" id="su-title">
        Signed up · {list.length}{run.capacity != null ? ` of ${run.capacity}` : ''}
      </h2>
      {list.length === 0 ? (
        <p className="muted">{run.signup_enabled ? 'No sign-ups yet.' : 'Sign-ups are closed.'}</p>
      ) : (
        <>
          <ol className="su-list">
            {list.map((p, i) => (
              <li key={`${p.phone}-${i}`}>
                <div className="su-row"><span>{p.name}</span><span className="muted">{p.phone}</span></div>
                {fields.some((f) => answerText(p.answers?.[f.id])) && (
                  <div className="su-answers">
                    {fields.filter((f) => answerText(p.answers?.[f.id])).map((f) => (
                      <span key={f.id}><span className="muted">{f.label}:</span> {answerText(p.answers[f.id])}</span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ol>
          <button className="btn ghost" onClick={downloadCsv}>Download list (CSV)</button>
        </>
      )}
    </section>
  );
}

// ---------- The QR that sits at the start line ----------
function VenueQr({ run, onChange }) {
  const [src, setSrc] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const link = checkinLink(run.id, run.check_in_code);
  const local = /localhost|127\.0\.0\.1/.test(window.location.hostname);

  useEffect(() => {
    QRCode.toDataURL(link, { width: 720, margin: 2, errorCorrectionLevel: 'M' }).then(setSrc).catch(() => setSrc(''));
  }, [link]);

  async function download() {
    const img = new Image();
    img.src = src;
    await img.decode();
    const W = 1000, H = 1280;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#0a0a0a'; g.textAlign = 'center';
    g.font = '800 64px "Barlow Condensed", Arial Narrow, sans-serif';
    g.fillText('SCAN TO ATTEND', W / 2, 120);
    g.drawImage(img, 140, 170, 720, 720);
    g.font = '700 46px "Barlow Condensed", Arial Narrow, sans-serif';
    g.fillText(run.name.toUpperCase(), W / 2, 980, W - 120);
    g.font = '500 34px Barlow, Arial, sans-serif';
    g.fillStyle = '#6b6b6b';
    g.fillText([runDate(run.date, { weekday: 'long', day: 'numeric', month: 'long' }), runTime(run.time)].filter(Boolean).join(' · '), W / 2, 1040, W - 120);
    g.fillText('Open the Mvmnt Tribe app → Attend run, or use your camera.', W / 2, 1180, W - 80);
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = `mvmnt-qr-${run.date}.png`;
    a.click();
  }

  async function regenerate() {
    setBusy(true); setError('');
    try { onChange(await adminNewQr(run.id)); setConfirm(false); }
    catch (e) { setError(messageFor(e.code)); }
    finally { setBusy(false); }
  }

  return (
    <section className="qr-card" aria-labelledby="qr-title">
      <h2 className="section-title" id="qr-title">Venue QR</h2>
      <p className="muted">Print this and keep it at the start line. Runners scan it in the app to log the run. It only works on run day, and only for this run.</p>
      {local && <p className="flag-note">You're on a test copy. Make the QR from the live site so it points to the right address.</p>}
      {src && <img className="qr" src={src} alt="Check-in QR code for this run" />}
      <button className="btn" onClick={download} disabled={!src}>Download QR</button>
      {!confirm ? (
        <button className="link" onClick={() => setConfirm(true)}>Make a new code</button>
      ) : (
        <div className="stack">
          <p className="muted">The old QR stops working straight away. Use this if a photo of it got shared.</p>
          <button className="btn ghost" onClick={regenerate} disabled={busy}>{busy ? 'Working…' : 'Yes, make a new code'}</button>
          <button className="link" onClick={() => setConfirm(false)}>Cancel</button>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
