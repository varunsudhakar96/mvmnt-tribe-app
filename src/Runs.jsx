import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { upcomingRuns, pastEvents, runDetail, checkInRun, shareRun, signUp, cancelSignup, claimPayment, prefill, readScan, messageFor, runDate, runTime, formatPhone } from './api.js';
import { go, href } from './router.js';
import Badge from './Badge.jsx';
const Scanner = lazy(() => import('./Scanner.jsx'));

const digits = (p) => String(p || '').replace(/\D/g, '').slice(-10);
// Checkbox answers are lists; everything else is text.
export const answerText = (v) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));
const isBlank = (v) => (Array.isArray(v) ? v.length === 0 : !String(v ?? '').trim());
const isRun = (r) => (r?.kind ?? 'run') === 'run';
const isProgram = (r) => r?.kind === 'program';
const noun = (r) => (isProgram(r) ? 'program' : isRun(r) ? 'run' : 'event');
const KIND_TAG = { event: 'Event', program: 'Program' };
const holding = (r) => r?.my_status === 'pending' || r?.my_status === 'confirmed';
const pending = (r) => r?.my_status === 'pending';
const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const upiLink = (r) => `upi://pay?pa=${encodeURIComponent(r.upi_id)}&pn=${encodeURIComponent('Mvmnt Tribe')}&am=${Number(r.price || 0)}&cu=INR&tn=${encodeURIComponent(r.name.slice(0, 40))}`;
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
      <h2 className="section-title" id="upcoming">Coming up</h2>
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
                    {KIND_TAG[r.kind] && <span className="kind-tag">{KIND_TAG[r.kind]}</span>}
                    {isProgram(r) ? `Starts ${when(r)}` : when(r)}
                  </span>
                  <span className="run-name">{r.name}</span>
                  {r.venue && <span className="muted run-venue">{r.venue}</span>}
                  {isProgram(r) && r.classes && <span className="muted run-venue">{r.classes} classes{r.my_classes ? ` · you've done ${r.my_classes}` : ''}</span>}
                  {r.price > 0 && <span className="price-tag">{rupees(r.price)}</span>}
                  {r.signed_up && <span className="signed-tag">✓ Signed up</span>}
                  {pending(r) && <span className="signed-tag pending-tag">{r.my_payment === 'claimed' ? 'Payment being checked' : 'Payment pending'}</span>}
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

// ---------- Past events (home) ----------
export function PastEvents() {
  const [list, setList] = useState(undefined);
  const [all, setAll] = useState(false);
  useEffect(() => { pastEvents().then(setList).catch(() => setList([])); }, []);
  if (!list || list.length === 0) return null;
  const shown = all ? list : list.slice(0, 5);
  return (
    <section aria-labelledby="past" className="past-section">
      <h2 className="section-title" id="past">Past events</h2>
      <ul className="past-list">
        {shown.map((r) => (
          <li key={r.id}>
            <a href={href(`run/${r.id}`)}>
              <span className="past-copy">
                <span className="run-name">{r.name}</span>
                <span className="muted">
                  {KIND_TAG[r.kind] ? `${KIND_TAG[r.kind]} · ` : ''}{runDate(r.ended_on && isProgram(r) ? r.ended_on : r.date)}
                </span>
              </span>
              {r.checked_in || r.my_classes > 0
                ? <span className="signed-tag">{isProgram(r) ? `✓ ${r.my_classes}/${r.classes} classes` : '✓ Attended'}</span>
                : <span className="chev" aria-hidden="true">›</span>}
            </a>
          </li>
        ))}
      </ul>
      {list.length > 5 && !all && <button className="link inline" onClick={() => setAll(true)}>Show all {list.length}</button>}
    </section>
  );
}

// A program's progress: classes done, and the badge waiting at the end.
export function ProgramProgress({ run }) {
  const total = Number(run.classes || 0);
  const done = Math.min(total, Number(run.my_classes || 0));
  if (!total) return null;
  return (
    <section className="program-card" aria-label="Your progress">
      <div className="program-top">
        <div>
          <p className="eyebrow">Your classes</p>
          <p className="program-count"><strong>{done}</strong> of {total}</p>
        </div>
        {run.badge && <BadgeImg badge={run.badge} size={64} dim={!run.my_badge_earned} />}
      </div>
      <ol className="class-dots" aria-hidden="true">
        {Array.from({ length: total }, (_, i) => <li key={i} className={i < done ? 'on' : ''} />)}
      </ol>
      {run.badge && (
        <p className="muted">
          {run.my_badge_earned
            ? <>You've earned <strong>{run.badge.name}</strong>.</>
            : <>Check in to all {total} classes to earn <strong>{run.badge.name}</strong>.</>}
        </p>
      )}
    </section>
  );
}

export function BadgeImg({ badge, size = 72, dim = false }) {
  return (
    <span className={`badge-img${dim ? ' dim' : ''}`} style={{ width: size, height: size }}>
      {badge.image_url ? <img src={badge.image_url} alt={badge.name} /> : <span>{badge.name?.[0] || '★'}</span>}
    </span>
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
    ? (run.signup_fields || []).filter((f) => !isBlank(run.my_answers?.[f.id]))
    : [];

  return (
    <main className="shell has-dock">
      <header className="topbar">
        <a className="link back" href={href('')}>‹ Home</a>
        <span className="top-actions">
          {run && <ShareButton run={run} />}
          {!loggedIn && <a className="link" href={href(`login?next=run/${id}`)}>Log in</a>}
        </span>
      </header>

      {error && <p className="error" role="alert">{error}</p>}
      {!error && run === undefined && <p className="muted">Loading…</p>}
      {!error && run === null && <p className="muted">{messageFor('run_not_found')}</p>}

      {run && (
        <article className="event">
          {run.poster_url && <img className="event-poster" src={run.poster_url} alt={`${run.name} poster`} />}
          <div className="event-copy">
            {run.ended && <p className="ended-banner">{isProgram(run) ? 'Program ended' : 'Ended'}</p>}
            {run.ended ? null : run.checked_in ? (
              <p className="signed-banner"><span aria-hidden="true">✓</span> {isRun(run) ? `Run logged · ${kmText(run.my_checkin_km)} km` : isProgram(run) ? 'Checked in today' : 'Checked in'}</p>
            ) : run.signed_up && !run.is_past ? (
              <p className="signed-banner"><span aria-hidden="true">✓</span> You're signed up</p>
            ) : pending(run) && !run.is_past && (
              <p className="pending-banner">{run.my_payment === 'claimed' ? 'Waiting for payment confirmation' : 'Payment pending'}</p>
            )}
            <p className="eyebrow">
              {run.is_today && !isProgram(run) && <span className="today">Today</span>}
              {KIND_TAG[run.kind] && <span className="kind-tag">{KIND_TAG[run.kind]}</span>}
              {isProgram(run) ? `${run.is_today || run.check_in_live || run.is_past ? 'Started' : 'Starts'} ${when(run)}` : when(run)}
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
            {isProgram(run) && run.classes && !run.my_classes && !holding(run) && (
              <p className="spots">{run.classes} classes{run.badge ? ` · finish them all to earn ${run.badge.name}` : ''}</p>
            )}
            {isProgram(run) && (run.my_classes > 0 || holding(run)) && <ProgramProgress run={run} />}
            {run.price > 0 && !holding(run) && !run.is_past && (
              <p className="spots">{rupees(run.price)} · pay after you sign up</p>
            )}
            {!run.is_past && run.signup_enabled && run.capacity != null && !holding(run) && (
              <p className="spots">{run.spots_left > 0 ? `${run.spots_left} of ${run.capacity} spots left` : 'This one is full.'}</p>
            )}
            {run.is_past && <p className="note">This {noun(run)} has {run.ended ? 'ended' : 'finished'}.</p>}
            {!run.is_past && !run.check_in_live && !run.signed_up && run.can_attend && (
              <p className="hint">{isProgram(run) ? 'Check-in opens at the first class.' : 'Check-in opens on the day.'} Scan the QR at the venue to check in.</p>
            )}
            {isProgram(run) && run.check_in_live && !run.checked_in && <p className="hint">Scan the QR at each class to check in.</p>}
            {run.is_today && !run.can_attend && <p className="hint">Check-in isn't open yet.</p>}
            {run.checked_in && run.is_today && isRun(run) && (
              <p className="hint">Wrong distance? Tap Attend run and scan the QR again to fix it.</p>
            )}

            {holding(run) && run.price > 0 && !run.is_past && <PayCard run={run} onChange={setRun} />}

            {holding(run) && !run.is_past && !(run.checked_in && !isProgram(run)) && !(isProgram(run) && run.my_classes > 0) && (
              <div className="my-signup">
                {answered.length > 0 && (
                  <dl className="confirm-facts">
                    {answered.map((f) => (
                      <div key={f.id}><dt>{f.label}</dt><dd>{answerText(run.my_answers[f.id])}</dd></div>
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
                    <p className="muted">Cancel your sign-up? You can sign up again later{run.capacity != null ? ' if spots are left' : ''}.</p>
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

function PayCard({ run, onChange }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const status = run.my_payment || 'none';
  async function claim() {
    setBusy(true); setErr('');
    try { onChange(await claimPayment(run.id)); } catch (e) { setErr(messageFor(e.code)); } finally { setBusy(false); }
  }
  if (status === 'confirmed') {
    return <p className="pay-done"><span aria-hidden="true">✓</span> Paid {rupees(run.price)}. Thank you.</p>;
  }
  return (
    <section className="pay-card" aria-labelledby="pay-title">
      <h2 className="section-title" id="pay-title">Pay {rupees(run.price)}</h2>
      {status === 'claimed' ? (
        <p className="muted">Thanks. We're checking your payment. Your spot is confirmed as soon as the organiser marks it paid.</p>
      ) : (
        <p className="muted">Your spot is held. Pay with any UPI app, then tap “I've paid”.</p>
      )}
      {status === 'none' && run.payment_qr_url && <img className="pay-qr" src={run.payment_qr_url} alt="Payment QR code" />}
      {status === 'none' && run.upi_id && <a className="btn" href={upiLink(run)}>Pay with UPI app</a>}
      {status === 'none' && run.payment_qr_url && (
        <a className="link inline center-link" href={run.payment_qr_url} download target="_blank" rel="noreferrer">
          Save the QR to pay from another app
        </a>
      )}
      {status === 'none' && run.upi_id && <p className="hint center">UPI ID: <strong>{run.upi_id}</strong></p>}
      {status === 'none' && (
        <button className={run.upi_id ? 'btn ghost' : 'btn'} onClick={claim} disabled={busy}>{busy ? 'Saving…' : "I've paid"}</button>
      )}
      {err && <p className="error" role="alert">{err}</p>}
    </section>
  );
}

export function ShareButton({ run, className = 'share-btn' }) {
  const [note, setNote] = useState('');
  async function share() {
    const r = await shareRun(run);
    if (r === 'copied') { setNote('Link copied'); setTimeout(() => setNote(''), 2200); }
  }
  return (
    <button type="button" className={className} onClick={share} aria-label={`Share ${run.name}`}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></svg>
      <span>{note || 'Share'}</span>
    </button>
  );
}

function RunActions({ run, loggedIn }) {
  if (run.is_past) return null;
  const attendLive = run.check_in_live;
  const checkedIn = run.checked_in;
  const attendLabel = isRun(run) ? 'Attend run' : isProgram(run) ? 'Check in to class' : 'Check in';
  const attendLocked = !attendLive && run.signed_up && (isProgram(run) || !run.is_today);
  const canSignup = run.signup_enabled && !holding(run) && !checkedIn && !(run.my_classes > 0);
  const full = canSignup && run.capacity != null && run.spots_left <= 0;
  if (!attendLive && !attendLocked && !canSignup) return null;
  const to = (path) => (loggedIn ? href(path) : href(`login?next=${path}`));
  return (
    <div className="dock">
      <div className="dock-inner">
        {attendLive && !(checkedIn && !isRun(run)) && <a className={checkedIn ? 'btn ghost' : 'btn'} href={to(`run/${run.id}/scan`)}>{checkedIn ? 'Scan again to fix distance' : attendLabel}</a>}
        {attendLive && checkedIn && isProgram(run) && <button className="btn" disabled>Checked in today ✓</button>}
        {attendLocked && (
          <div className="locked">
            <button className="btn" disabled aria-describedby="attend-note">{attendLabel}</button>
            <p className="hint" id="attend-note">{isProgram(run) ? 'Activates at the first class.' : 'Activates on the day.'} Scan the QR at the venue to check in.</p>
          </div>
        )}
        {canSignup && (full
          ? <button className="btn" disabled>Full</button>
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
    const miss = fields.filter((f) => f.required && isBlank(answers[f.id])).map((f) => f.id);
    setMissing(miss);
    if (miss.length) { setError(messageFor('answer_required')); return; }
    setBusy(true); setError('');
    try {
      const clean = Object.fromEntries(fields
        .map((f) => [f.id, f.type === 'checkboxes' ? (answers[f.id] || []) : String(answers[f.id] ?? '').trim()])
        .filter(([, v]) => !isBlank(v)));
      setDone(await signUp(id, clean));
    } catch (err) {
      setError(messageFor(err.code));
    } finally {
      setBusy(false);
    }
  }

  if (done && pending(done)) return <PendingScreen run={done} onChange={setDone} onDone={() => go(`run/${id}`)} />;
  if (done) return <SignedUpScreen run={done} onDone={() => go(`run/${id}`)} />;

  const editing = holding(run);
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
  if (f.type === 'checkboxes') {
    const picked = Array.isArray(value) ? value : [];
    const toggle = (o) => onChange(picked.includes(o) ? picked.filter((x) => x !== o) : (f.options || []).filter((x) => x === o || picked.includes(x)));
    return (
      <fieldset className="field choice" aria-invalid={invalid}>
        <legend className="label">{label}<span className="hint"> · pick any</span></legend>
        <div className="options stacked">
          {(f.options || []).map((o) => (
            <label key={o} className={`option box${picked.includes(o) ? ' on' : ''}`}>
              <input type="checkbox" value={o} checked={picked.includes(o)} onChange={() => toggle(o)} />
              <span><i aria-hidden="true" />{o}</span>
            </label>
          ))}
        </div>
        {invalid && <span className="error small">Tick at least one.</span>}
      </fieldset>
    );
  }
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

function PendingScreen({ run, onChange, onDone }) {
  const claimed = run.my_payment === 'claimed';
  return (
    <main className="shell confirm">
      <div className="confirm-body pending-body">
        <p className="pending-banner">{claimed ? 'Waiting for confirmation' : 'Pending'}</p>
        <h1 className="display">{claimed ? 'Payment sent.' : 'One last step.'}</h1>
        <p className="lede">
          {claimed
            ? <>We're checking your payment for <strong>{run.name}</strong>. You'll show as signed up once it's confirmed.</>
            : <>Your spot for <strong>{run.name}</strong> is held. Pay {rupees(run.price)} to confirm it.</>}
        </p>
        <dl className="confirm-facts">
          <div><dt>When</dt><dd>{when(run) || runDate(run.date)}</dd></div>
          {run.venue && <div><dt>Where</dt><dd>{run.venue}</dd></div>}
        </dl>
        <PayCard run={run} onChange={onChange} />
      </div>
      <button className={claimed ? 'btn' : 'btn ghost'} onClick={onDone}>{claimed ? 'Done' : "I'll pay later"}</button>
    </main>
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
        <div className="note"><p>{isProgram(run)
          ? <>At every class, open this program and tap <strong>Check in to class</strong>, then scan the QR at the venue.{run.badge ? <> Make all {run.classes} to earn <strong>{run.badge.name}</strong>.</> : ''}</>
          : <>On the day, open this {noun(run)} and tap <strong>{isRun(run) ? 'Attend run' : 'Check in'}</strong>, then scan the QR at the venue.</>}</p></div>
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
          <button className="btn ghost" onClick={() => go(`run/${id}`)}>Back</button>
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
        if (r && !r.check_in_live) setError(messageFor(r.ended ? 'event_ended' : isProgram(r) && !r.is_past ? 'program_not_started' : 'not_today'));
      })
      .catch((e) => setError(messageFor(e.code)));
  }, [id]);

  const step = (d) => setKm((v) => kmText(Math.min(60, Math.max(0.5, (Number(v) || 0) + d))));

  async function log() {
    const n = isRun(run) ? Number(km) : null;
    if (isRun(run) && !(n >= 0.5 && n <= 60)) { setError(messageFor('bad_distance')); return; }
    setBusy(true); setError('');
    try { setResult(await checkInRun(id, code, n)); onLogged?.(); }
    catch (e) { setError(messageFor(e.code)); }
    finally { setBusy(false); }
  }

  if (result) return <RunLogged r={result} onDone={() => go('')} />;

  const blocked = run === null || (run && !run.check_in_live);
  return (
    <main className="shell">
      <header className="topbar"><a className="link back" href={href(`run/${id}`)}>‹ Back</a></header>
      {run === undefined && !error && <p className="muted">Loading…</p>}
      {run === null && <p className="error" role="alert">{messageFor('run_not_found')}</p>}
      {run && (
        <div className="stack">
          <div>
            <p className="eyebrow">{run.checked_in && isRun(run) ? 'Fix your distance' : isProgram(run) ? `Class ${Math.min(Number(run.classes || 1), Number(run.my_classes || 0) + (run.checked_in ? 0 : 1))} of ${run.classes}` : 'Check in'}</p>
            <h1 className="display">{run.name}</h1>
            {run.venue && <p className="lede">{run.venue}</p>}
          </div>
          {!blocked && isRun(run) && (
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
          {!blocked && <button className="btn" onClick={log} disabled={busy}>{busy ? 'Checking in…' : isRun(run) ? 'Log my run' : 'Check me in'}</button>}
          {blocked && <a className="btn ghost" href={href(`run/${id}`)}>See the {run ? noun(run) : 'event'}</a>}
        </div>
      )}
    </main>
  );
}

function RunLogged({ r, onDone }) {
  if (r.kind === 'program') {
    const total = Number(r.classes || 0);
    const done = Math.min(total || Infinity, Number(r.done || 0));
    return (
      <main className="shell confirm">
        <div className="confirm-body">
          <div className="tick" aria-hidden="true"><svg viewBox="0 0 52 52"><path d="M14 27l8 8 16-18" /></svg></div>
          <h1 className="display">{r.first_time ? `Class ${done} done.` : 'Already in today.'}</h1>
          <p className="lede">{r.first_time ? <>You're checked in to <strong>{r.run}</strong>.</> : <>You'd already checked in to <strong>{r.run}</strong> today. One check-in per class.</>}</p>
          {total > 0 && (
            <>
              <p className="logged-km">{done}<span>of {total}</span></p>
              <ol className="class-dots" aria-label={`${done} of ${total} classes`}>
                {Array.from({ length: total }, (_, i) => <li key={i} className={i < done ? 'on' : ''} />)}
              </ol>
            </>
          )}
          {r.badge_earned && r.badge && (
            <div className="unlock" role="status">
              <BadgeImg badge={r.badge} size={96} />
              <div>
                <p className="eyebrow">New badge</p>
                <p className="badge-name">{r.badge.name}</p>
                <p className="muted">You finished every class. It's on your profile now.</p>
              </div>
            </div>
          )}
          {!r.badge_earned && r.badge && total > done && (
            <p className="muted">{total - done} more {total - done === 1 ? 'class' : 'classes'} to earn <strong>{r.badge.name}</strong>.</p>
          )}
        </div>
        <button className="btn" onClick={onDone}>Done</button>
      </main>
    );
  }
  if (r.kind === 'event') {
    return (
      <main className="shell confirm">
        <div className="confirm-body">
          <div className="tick" aria-hidden="true"><svg viewBox="0 0 52 52"><path d="M14 27l8 8 16-18" /></svg></div>
          <h1 className="display">You're checked in.</h1>
          <p className="lede">Welcome to <strong>{r.run}</strong>. Enjoy it.</p>
        </div>
        <button className="btn" onClick={onDone}>Done</button>
      </main>
    );
  }
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
