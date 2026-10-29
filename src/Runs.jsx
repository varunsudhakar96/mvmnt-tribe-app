import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { upcomingRuns, runDetail, attendRun, prefill, readScan, messageFor, runDate, runTime } from './api.js';
import { go, href } from './router.js';
const Scanner = lazy(() => import('./Scanner.jsx'));

const digits = (p) => String(p || '').replace(/\D/g, '').slice(-10);
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

// ---------- Run event page ----------
export function RunPage({ id, profile }) {
  const [run, setRun] = useState(undefined);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    runDetail(id)
      .then((r) => live && setRun(r))
      .catch((e) => live && setError(messageFor(e.code)));
    return () => { live = false; };
  }, [id]);

  const me = { name: profile?.name, phone: digits(profile?.phone) };

  return (
    <main className="shell has-dock">
      <header className="topbar">
        <a className="link back" href={href('')}>‹ Runs</a>
      </header>

      {error && <p className="error" role="alert">{error}</p>}
      {!error && run === undefined && <p className="muted">Loading…</p>}
      {!error && run === null && <p className="muted">{messageFor('run_not_found')}</p>}

      {run && (
        <article className="event">
          {run.poster_url && <img className="event-poster" src={run.poster_url} alt={`${run.name} poster`} />}
          <div className="event-copy">
            <p className="eyebrow">
              {run.is_today && <span className="today">Today</span>}
              {when(run)}
            </p>
            <h1 className="display">{run.name}</h1>
            {run.venue && (
              <div className="venue">
                <span className="venue-name">{run.venue}</span>
                {run.map_url && (
                  <a className="link inline" href={run.map_url} target="_blank" rel="noreferrer">
                    Open in Maps
                  </a>
                )}
              </div>
            )}
            {!run.venue && run.map_url && (
              <a className="link inline" href={run.map_url} target="_blank" rel="noreferrer">Open in Maps</a>
            )}
            {run.description && <p className="event-desc">{run.description}</p>}
            {run.is_past && <p className="note">This run has finished.</p>}
            {!run.is_past && !run.is_today && run.can_attend && (
              <p className="hint">“Attend run” unlocks on run day. Scan the QR at the start line to check in.</p>
            )}
            {run.is_today && !run.can_attend && (
              <p className="hint">Check-in isn't open for this run yet.</p>
            )}
          </div>

          <RunActions run={run} me={me} />
        </article>
      )}
    </main>
  );
}

function RunActions({ run, me }) {
  const showAttend = run.is_today && run.can_attend;
  const showSignup = run.signup_url && !run.is_past;
  if (!showAttend && !showSignup) return null;
  return (
    <div className="dock">
      <div className="dock-inner">
        {showAttend && <a className="btn" href={href(`run/${run.id}/scan`)}>Attend run</a>}
        {showSignup && (
          <a className={showAttend ? 'btn ghost' : 'btn'} href={prefill(run.signup_url, me)}
             target="_blank" rel="noreferrer">Sign up</a>
        )}
      </div>
    </div>
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
    await checkIn(s.id, s.code);
  }

  async function checkIn(runId, code) {
    setState({ phase: 'going' });
    try {
      const r = await attendRun(runId, code);
      window.location.assign(prefill(r.url, { name: r.name || me.name, phone: r.phone || me.phone }));
    } catch (e) {
      setState({ phase: 'error', message: messageFor(e.code) });
    }
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
export function CheckInPage({ id, code }) {
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    attendRun(id, code)
      .then((r) => {
        if (live) window.location.replace(prefill(r.url, { name: r.name, phone: r.phone }));
      })
      .catch((e) => live && setError(messageFor(e.code)));
    return () => { live = false; };
  }, [id, code]);

  return (
    <main className="shell">
      <header className="topbar"><a className="link back" href={href('')}>‹ Home</a></header>
      {!error && <p className="status">Checking you in…</p>}
      {error && (
        <div className="stack">
          <p className="error" role="alert">{error}</p>
          <a className="btn ghost" href={href(`run/${id}`)}>See the run</a>
        </div>
      )}
    </main>
  );
}
