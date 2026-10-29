import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  adminListRuns, adminSaveRun, adminDeleteRun, adminNewQr, uploadPoster,
  checkinLink, messageFor, runDate, runTime,
} from './api.js';
import { go, href } from './router.js';

const LAST_ATTEND = 'mvmnt.lastAttendUrl';
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
                {!r.attend_url && !r.is_past && <span className="flag">No attend form</span>}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- Add / edit ----------
const EMPTY = { name: '', date: '', time: '06:00', venue: '', map_url: '', description: '', signup_url: '', attend_url: '', poster_url: '' };

export function AdminRunEdit({ id }) {
  const isNew = id === 'new';
  const [form, setForm] = useState(isNew ? { ...EMPTY, attend_url: recall(LAST_ATTEND) } : null);
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
      if (r.attend_url) remember(LAST_ATTEND, r.attend_url);
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
        <h1 className="display">{isNew ? 'New run' : 'Edit run'}</h1>

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
        <Field label="Sign-up form link" hint="Shows a Sign up button until the run is over. Leave empty to hide it.">
          <input className="input" type="url" inputMode="url" value={form.signup_url} onChange={set('signup_url')} placeholder="https://forms.gle/…" />
        </Field>
        <Field label="Attend form link"
               hint="Opens after a runner scans the venue QR on run day. Tip: use the form's “Get pre-filled link”, type 9999999999 in the phone question and NAME in the name question, and paste that link. Each runner's number and name then fill in automatically.">
          <input className="input" type="url" inputMode="url" value={form.attend_url} onChange={set('attend_url')} placeholder="https://docs.google.com/forms/…" />
        </Field>

        {error && <p className="error" role="alert">{error}</p>}
        {notice && !error && <p className="saved" role="status">{notice}</p>}
        <button className="btn" type="submit" disabled={!!busy}>
          {busy === 'save' ? 'Saving…' : isNew ? 'Publish run' : 'Save changes'}
        </button>
      </form>

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
      <p className="muted">Print this and keep it at the start line. It only works on run day, and only for this run.</p>
      {!run.attend_url && <p className="flag-note">Add an attend form link above, or scanning won't have anywhere to go.</p>}
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
