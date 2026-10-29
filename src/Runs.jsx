import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { upcomingRuns, runDetail, checkInRun, signUp, cancelSignup, prefill, readScan, messageFor, runDate, runTime, formatPhone } from './api.js';
import { go, href } from './router.js';
import Wordmark from './Wordmark.jsx';
import Badge from './Badge.jsx';
const Scanner = lazy(() => import('./Scanner.jsx'));

const digits = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const kmText = (n) => { const v = Number(n || 0); return Number.isInteger(v) ? String(v) : String(+v.toFixed(2)); };
const when = (r) => [runDate(r.date), runTime(r.time)].filter(Boolean).join(' · ');

function Poster({ src, alt, className }) {
  if (!src) {
    return (
      <div className={`${className} poster-blank`} aria-hidden="true">
        <span>RUN</span>
      </div>
    );
  }
  return <img className={className} src={src} alt={alt} loading="lazy" />;
}

// ---------- Home section ----------
export function UpcomingRuns() {
  const [runs, setRuns] = useState(undefined);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try { setRuns(await upcomingRuns()); } catch (e) { setError(messageFor(e.code)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <section aria-labelledby="upcoming">
      <h2 className="section-title" id="upcoming">Upcoming runs</h2>
      {error && (
        <p className="muted">
          {error} <button className="link inline" onClick={load}>Retry</button>
        </p>
      )}
      {!error && runs === undefined && <p className="muted">Loading runs…</p>}
      {runs && runs.length === 0 && <p className="muted">No runs posted yet. Check back soon.</p>}
      {runs && runs.length > 0 && (
        <ul className="run-cards">
          {runs.map((r) => (
            <li key={r.id}>
              <a className="run-card" href={href(`run/${r.id}`)}>
                <Poster src={r.poster_url} alt="" className="run-thumb" />
                <span className="run-card-copy">
                  <span className="run-when">
                    {r.is_today && <span className="today">Today</span>}
                    {when(r)}
                  </span>
                  <span className="run-name">{r.name}</span>
                  {r.venue && <span className="muted run-venue">{r.venue}</span>}
                  {r.signed_up && <span className="signed-tag">✓ Signed up</span>}
                </span>
                <span className="chev" aria-hidden="true">›</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------- Run event page (public: works logged out) ----------
export function RunPage({ id, profile }) {
  const loggedIn = Boolean(profile);
  const [run, setRun] = useState(undefined);
  const [error, setError] = useState('');
  const [cancelAsk, setCancelAsk] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try { setRun(await runDetail(id)); } catch (e) { setError(messageFor(e.code)); }
  }, [id]);
  useEffect(() => { refresh(); }, [refresh]);

  async function cancel() {
    setBusy(true); setError('');
    try { setRun(await cancelSignup(id)); setCancelAsk(false); }
    catch (e) { setError(messageFor(e.code)); }
    finally { setBusy(false); }
  }

  const answered = run?.signed_up
    ? (run.signup_fields || []).filter((f) => run.my_answers?.[f.id])
    : [];

  return (
    <main className="shell has-dock">
      <header className="topbar">
        {loggedIn
          ? <a className="link back" href={href('')}>‹ Runs</a>
          : <><Wordmark small /><a className="link" href={href(`login?next=run/${id}`)}>Log in</a></>}
      </header>

      {error && <p className="error" role="alert">{error}</p>}
      {!error && run === undefined && <p className="muted">Loading…</p>}
      {!error && run === null && <p className="muted">{messageFor('run_not_found')}</p>}

      {run && (
        <article className="event">
          {run.poster_url && <img className="event-poster" src={run.poster_url} alt={`${run.name} poster`} />}
          <div className="event-copy">
            {run.my_checkin_km != null ? (
              <p className="signed-banner"><span aria-hidden="true">✓</span> Run logged · {kmText(run.my_checkin_km)} km</p>
            ) : run.signed_up && !run.is_past && (
              <p className="signed-banner"><span aria-hidden="true">✓</span> You're signed up</p>
            )}
            <p className="eyebrow">
              {run.is_today && <span className="today">Today</span>}
              {when(run)}
            </p>
            <h1 className="display">{run.name}</h1>
            {run.venue && (
              <div className="venue">
                <span className="venue-name">{run.venue}</span>
                {run.map_url && (
                  <a className="link inline" href={run.map_url} target="_blank" rel="noreferrer">Open in Maps</a>
                )}
              </div>
            )}
            {!run.venue && run.map_url && (
              <a className="link inline" href={run.map_url} target="_blank" rel="noreferrer">Open in Maps</a>
            )}
            {run.description && <p className="event-desc">{run.description}</p>}
            {!run.is_past && run.signup_enabled && run.capacity != null && !run.signed_up && (
              <p className="spots">{run.spots_left > 0 ? `${run.spots_left} of ${run.capacity} spots left` : 'This run is full.'}</p>
            )}
            {run.is_past && <p className="note">This run has finished.</p>}
            {!run.is_past && !run.is_today && !run.signed_up && run.can_attend && (
              <p className="hint">“Attend run” unlocks on run day. Scan the QR at the start line to check in.</p>
            )}
            {run.is_today && !run.can_attend && <p className="hint">Check-in isn't open for this run yet.</p>}
            {run.my_checkin_km != null && run.is_today && (
              <p className="hint">Wrong distance? Tap Attend run and scan the QR again to fix it.</p>
            )}

            {run.signed_up && !run.is_past && run.my_checkin_km == null && (
              <div className="my-signup">
                {answered.length > 0 && (
                  <dl className="confirm-facts">
                    {answered.map((f) => (
                      <div key={f.id}><dt>{f.label}</dt><dd>{run.my_answers[f.id]}</dd></div>
                    ))}
                  </dl>
                )}
                <div className="row">
                  {(run.signup_fields || []).length > 0 && (
                    <a className="link inline" href={href(`run/${run.id}/signup`)}>Change answers</a>
                  )}
                  {!cancelAsk && <button className="link inline" onClick={() => setCancelAsk(true)}>Can't make it?</button>}
                </div>
                {cancelAsk && (
                  <div className="stack">
                    <p className="muted">Cancel your sign-up for this run? You can sign up again later{run.capacity != null ? ' if spots are left' : ''}.</p>
                    <button className="btn ghost" onClick={cancel} disabled={busy}>{busy ? 'Cancelling…' : 'Yes, cancel my sign-up'}</button>
                    <button className="link" onClick={() => setCancelAsk(false)}>Keep my spot</button>
                  </div>
                )}
              </div>
            )}
          </div>

          <RunActions run={run} loggedIn={loggedIn} />
        </article>
      )}
    </main>
  );
}

function RunActions({ run, loggedIn }) {
  if (run.is_past) return null;
  const attendLive = run.is_today && run.can_attend;
  const checkedIn = run.my_checkin_km != null;
  const attendLocked = !attendLive && run.signed_up && !run.is_today;
  const canSignup = run.signup_enabled && !run.signed_up && !checkedIn;
  const full = canSignup && run.capacity != null && run.spots_left <= 0;
  if (!attendLive && !attendLocked && !canSignup) return null;
  const to = (path) => (loggedIn ? href(path) : href(`login?next=${path}`));
  return (
    <div className="dock">
      <div className="dock-inner">
        {attendLive && <a className={checkedIn ? 'btn ghost' : 'btn'} href={to(`run/${run.id}/scan`)}>{checkedIn ? 'Scan again to fix distance' : 'Attend run'}</a>}
        {attendLocked && (
          <div className="locked">
            <button className="btn" disabled aria-describedby="attend-note">Attend run</button>
            <p className="hint" id="attend-note">Activates on the day of the run. Scan the QR at the start line to check in.</p>
          </div>
        )}
        {canSignup && (full
          ? <button className="btn" disabled>Run is full</button>
          : <a className={attendLive ? 'btn ghost' : 'btn'} href={to(`run/${run.id}/signup`)}>Sign up</a>)}
        {!loggedIn && (canSignup || attendLive) && (
          <p className="hint center">You'll log in with your number first.</p>
        )}
      </div>
    </div>
  );
}

// ---------- Sign-up form ----------
export function SignupPage({ id, profile }) {
  const [run, setRun] = useState(undefined);
  const [answers, setAnswers] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [missing, setMissing] = useState([]);

  useEffect(() => {
    runDetail(id)
      .then((r) => { setRun(r); setAnswers(r?.my_answers || {}); })
      .catch((e) => setError(messageFor(e.code)));
  }, [id]);

  const fields = run?.signup_fields || [];
  const set = (fid, v) => { setAnswers((a) => ({ ...a, [fid]: v })); setMissing((m) => m.filter((x) => x !== fid)); setError(''); };

  async function submit(e) {
    e.preventDefault();
    const miss = fields.filter((f) => f.required && !String(answers[f.id] ?? '').trim()).map((f) => f.id);
    setMissing(miss);
    if (miss.length) { setError(messageFor('answer_required')); return; }
    setBusy(true); setError('');
    try {
      const clean = Object.fromEntries(fields.map((f) => [f.id, String(answers[f.id] ?? '').trim()]).filter(([, v]) => v));
      setDone(await signUp(id, clean));
    } catch (err) {
      setError(messageFor(err.code));
    } finally {
      setBusy(false);
    }
  }

  if (done) return <SignedUpScreen run={done} onDone={() => go(`run/${id}`)} />;

  const editing = run?.signed_up;
  const closed = run && (run.is_past || !run.signup_enabled);
  const full = run && !editing && run.capacity != null && run.spots_left <= 0;

  return (
    <main className="shell">
      <header className="topbar"><a className="link back" href={href(`run/${id}`)}>‹ Back</a></header>
      {error && !run && <p className="error" role="alert">{error}</p>}
      {run === undefined && !error && <p className="muted">Loading…</p>}
      {run === null && <p className="muted">{messageFor('run_not_found')}</p>}
      {run && (
        <form className="stack" onSubmit={submit} noValidate>
          <div>
            <p className="eyebrow">{when(run)}</p>
            <h1 className="display">{editing ? 'Your answers' : 'Sign up'}</h1>
            <p className="lede">{run.name}</p>
          </div>
          <div className="as-who">
            <span className="muted">Signing up as</span>
            <strong>{profile?.name}</strong>
            <span className="muted tabular">{formatPhone(digits(profile?.phone))}</span>
          </div>

          {closed && <p className="note">{messageFor(run.is_past ? 'run_over' : 'signups_closed')}</p>}
          {full && <p className="note">{messageFor('run_full')}</p>}

          {!closed && !full && fields.map((f) => (
            <Question key={f.id} f={f} value={answers[f.id] ?? ''} onChange={(v) => set(f.id, v)} invalid={missing.includes(f.id)} />
          ))}

          {error && run && <p className="error" role="alert">{error}</p>}
          {!closed && !full && (
            <button className="btn" type="submit" disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save answers' : 'Confirm sign-up'}
            </button>
          )}
        </form>
      )}
    </main>
  );
}

function Question({ f, value, onChange, invalid }) {
  const id = `q-${f.id}`;
  const label = <>{f.label}{f.required && <span className="req"> *</span>}</>;
  if (f.type === 'choice' || f.type === 'yes_no') {
    const opts = f.type === 'yes_no' ? ['Yes', 'No'] : f.options || [];
    return (
      <fieldset className="field choice" aria-invalid={invalid}>
        <legend className="label">{label}</legend>
        <div className="options">
          {opts.map((o) => (
            <label key={o} className={`option${value === o ? ' on' : ''}`}>
              <input type="radio" name={id} value={o} checked={value === o} onChange={() => onChange(o)} />
              <span>{o}</span>
            </label>
          ))}
        </div>
        {invalid && <span className="error small">Pick one.</span>}
      </fieldset>
    );
  }
  return (
    <label className="field" htmlFor={id}>
      <span className="label">{label}</span>
      {f.type === 'long_text'
        ? <textarea id={id} className="input area" rows={3} value={value} maxLength={1000} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} />
        : <input id={id} className="input" value={value} maxLength={1000}
                 type={f.type === 'number' ? 'text' : 'text'} inputMode={f.type === 'number' ? 'decimal' : undefined}
                 onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} />}
      {invalid && <span className="error small">This one's required.</span>}
    </label>
  );
}

function SignedUpScreen({ run, onDone }) {
  return (
    <main className="shell confirm">
      <div className="confirm-body">
        <div className="tick" aria-hidden="true">
          <svg viewBox="0 0 52 52"><path d="M14 27l8 8 16-18" /></svg>
        </div>
        <h1 className="display">You're in.</h1>
        <p className="lede">You're signed up for <strong>{run.name}</strong>.</p>
        <dl className="confirm-facts">
          <div><dt>When</dt><dd>{when(run) || runDate(run.date)}</dd></div>
          {run.venue && <div><dt>Where</dt><dd>{run.venue}</dd></div>}
        </dl>
        <div className="note"><p>On run day, open this run and tap <strong>Attend run</strong>, then scan the QR at the start line.</p></div>
      </div>
      <button className="btn" onClick={onDone}>Done</button>
    </main>
  );
}

// ---------- Attend: scan the venue QR ----------
export function ScanPage({ id, profile }) {
  const [state, setState] = useState({ phase: 'scan' });
  const me = { name: profile?.name, phone: digits(profile?.phone) };

  async function handle(text) {
    const s = readScan(text);
    if (s.kind === 'form') {
      setState({ phase: 'going' });
      window.location.assign(prefill(s.url, me));
      return;
    }
    if (s.kind !== 'checkin') {
      setState({ phase: 'error', message: messageFor('not_qr') });
      return;
    }
    go(`run/${s.id}/checkin?c=${s.code}`);
  }

  return (
    <main className="shell scan-shell">
      <header className="topbar">
        <a className="link back" href={href(`run/${id}`)}>‹ Back</a>
      </header>
      <h1 className="display">Scan the QR</h1>
      <p className="lede">Point your camera at the Mvmnt Tribe code at the start line.</p>

      {state.phase === 'scan' && (
        <Suspense fallback={<div className="scanner" />}>
          <Scanner onResult={handle} onError={(code) => setState({ phase: 'error', message: messageFor(code), camera: true })} />
        </Suspense>
      )}
      {state.phase === 'going' && <p className="status">Checking you in…</p>}
      {state.phase === 'error' && (
        <div className="stack scan-error">
          <p className="error" role="alert">{state.message}</p>
          {!state.camera && <button className="btn" onClick={() => setState({ phase: 'scan' })}>Scan again</button>}
          <button className="btn ghost" onClick={() => go(`run/${id}`)}>Back to the run</button>
        </div>
      )}
    </main>
  );
}

// Opened by scanning the venue QR with the phone's own camera: #/run/<id>/checkin?c=<code>
export function CheckInPage({ id, code, onLogged }) {
  const [run, setRun] = useState(undefined);
  const [km, setKm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    runDetail(id)
      .then((r) => {
        setRun(r);
        if (r) setKm(kmText(r.my_checkin_km ?? r.run_km ?? 5));
        if (r && !r.is_today) setError(messageFor('not_today'));
      })
      .catch((e) => setError(messageFor(e.code)));
  }, [id]);

  const step = (d) => setKm((v) => kmText(Math.min(60, Math.max(0.5, (Number(v) || 0) + d))));

  async function log() {
    const n = Number(km);
    if (!(n >= 0.5 && n <= 60)) { setError(messageFor('bad_distance')); return; }
    setBusy(true); setError('');
    try { setResult(await checkInRun(id, code, n)); onLogged?.(); }
    catch (e) { setError(messageFor(e.code)); }
    finally { setBusy(false); }
  }

  if (result) return <RunLogged r={result} onDone={() => go('')} />;

  const blocked = run === null || (run && !run.is_today);
  return (
    <main className="shell">
      <header className="topbar"><a className="link back" href={href(`run/${id}`)}>‹ Back</a></header>
      {run === undefined && !error && <p className="muted">Loading…</p>}
      {run === null && <p className="error" role="alert">{messageFor('run_not_found')}</p>}
      {run && (
        <div className="stack">
          <div>
            <p className="eyebrow">{run.my_checkin_km != null ? 'Fix your distance' : 'Check in'}</p>
            <h1 className="display">{run.name}</h1>
            {run.venue && <p className="lede">{run.venue}</p>}
          </div>
          {!blocked && (
            <div className="distance">
              <span className="label" id="km-label">How far did you run?</span>
              <div className="stepper" role="group" aria-labelledby="km-label">
                <button type="button" onClick={() => step(-0.5)} aria-label="Less">−</button>
                <input inputMode="decimal" value={km} aria-label="Distance in km"
                       onChange={(e) => setKm(e.target.value.replace(/[^0-9.]/g, '').slice(0, 5))} />
                <button type="button" onClick={() => step(0.5)} aria-label="More">+</button>
              </div>
              <span className="hint center">km · today's route is {kmText(run.run_km)} km</span>
            </div>
          )}
          {error && <p className="error" role="alert">{error}</p>}
          {!blocked && <button className="btn" onClick={log} disabled={busy}>{busy ? 'Logging…' : 'Log my run'}</button>}
          {blocked && <a className="btn ghost" href={href(`run/${id}`)}>See the run</a>}
        </div>
      )}
    </main>
  );
}

function RunLogged({ r, onDone }) {
  const unlocked = r.first_time && r.badge && r.badge !== r.badge_before; // a distance fix never re-announces
  const title = (s) => s.charAt(0) + s.slice(1).toLowerCase();
  return (
    <main className="shell confirm">
      <div className="confirm-body">
        <div className="tick" aria-hidden="true"><svg viewBox="0 0 52 52"><path d="M14 27l8 8 16-18" /></svg></div>
        <h1 className="display">{r.first_time ? 'Run logged.' : 'Distance updated.'}</h1>
        <p className="logged-km">{r.first_time ? '+' : ''}{kmText(r.km)}<span>km</span></p>
        <dl className="confirm-facts">
          <div><dt>Your total</dt><dd>{kmText(r.total_km)} km</dd></div>
          <div><dt>Runs</dt><dd>{r.total_runs}</dd></div>
        </dl>
        {unlocked && (
          <div className="unlock" role="status">
            <Badge tier={r.badge} size={96} />
            <div>
              <p className="eyebrow">New badge</p>
              <p className="badge-name">{title(r.badge)} unlocked</p>
              <p className="muted">Collect it from the Mvmnt Tribe crew.</p>
            </div>
          </div>
        )}
      </div>
      <button className="btn" onClick={onDone}>Done</button>
    </main>
  );
}
