import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { getProfile, logOut, messageFor } from './api.js';
import { useRoute, href } from './router.js';
import Wordmark from './Wordmark.jsx';
import Badge from './Badge.jsx';
import { UpcomingRuns, RunPage, ScanPage, CheckInPage } from './Runs.jsx';
const AdminRuns = lazy(() => import('./Admin.jsx').then((m) => ({ default: m.AdminRuns })));
const AdminRunEdit = lazy(() => import('./Admin.jsx').then((m) => ({ default: m.AdminRunEdit })));
const Wait = ({ children }) => (
  <Suspense fallback={<main className="shell"><p className="muted">Loading…</p></main>}>{children}</Suspense>
);

const TIERS = [
  { badge: 'PACER', km: 25 },
  { badge: 'STRIDER', km: 50 },
  { badge: 'RANGER', km: 100 },
  { badge: 'WAYFARER', km: 200 },
  { badge: 'VOYAGER', km: 300 },
];

const km = (n) => {
  const v = Number(n ?? 0);
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, '');
};
const shortDate = (iso) =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—';
const title = (s) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : '');

export default function Home() {
  const [profile, setProfile] = useState(undefined);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setProfile(await getProfile());
    } catch (err) {
      setError(messageFor(err.code));
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  const { parts, query } = useRoute();

  if (profile) {
    const [a, b, c] = parts;
    if (a === 'run' && b && c === 'scan') return <ScanPage id={b} profile={profile} />;
    if (a === 'run' && b && c === 'checkin') return <CheckInPage id={b} code={query.get('c') || ''} />;
    if (a === 'run' && b) return <RunPage id={b} profile={profile} />;
    if (a === 'admin') {
      if (!profile.is_admin) return <NotAllowed />;
      if (b === 'run' && c) return <Wait><AdminRunEdit id={c} /></Wait>;
      return <Wait><AdminRuns /></Wait>;
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <Wordmark small />
        <span className="top-actions">
          {profile?.is_admin && <a className="link" href={href('admin')}>Admin</a>}
          <button className="link" onClick={logOut}>Log out</button>
        </span>
      </header>

      {error && (
        <div className="stack">
          <p className="error" role="alert">{error}</p>
          <button className="btn" onClick={load}>Try again</button>
        </div>
      )}

      {!error && profile === undefined && <p className="muted">Loading your runs…</p>}

      {!error && profile === null && (
        <p className="muted">
          We couldn't find your runner profile. Message the Mvmnt Tribe team and we'll sort it out.
        </p>
      )}

      {profile && <Dashboard p={profile} />}
    </main>
  );
}

function NotAllowed() {
  return (
    <main className="shell">
      <header className="topbar"><a className="link back" href={href('')}>‹ Home</a></header>
      <p className="muted">{messageFor('not_admin')}</p>
    </main>
  );
}

function Dashboard({ p }) {
  const total = Number(p.total_km ?? 0);
  const prev = [...TIERS].reverse().find((t) => total >= t.km)?.km ?? 0;
  const next = p.next_badge_km ?? null;
  const progress = next ? Math.min(100, Math.max(0, ((total - prev) / (next - prev)) * 100)) : 100;
  const firstName = (p.name || '').split(' ')[0];

  return (
    <div className="dash">
      <section aria-labelledby="hello">
        <p className="eyebrow" id="hello">Hi, {firstName}</p>
        <p className="hero-km">
          {km(total)}<span>km</span>
        </p>
        <dl className="stats">
          <div><dt>Runs</dt><dd>{p.total_runs ?? 0}</dd></div>
          <div><dt>Rank</dt><dd>{p.rank ? <>#{p.rank}<small> of {p.runners}</small></> : '—'}</dd></div>
          <div><dt>Last run</dt><dd>{shortDate(p.last_run)}</dd></div>
        </dl>
      </section>

      <UpcomingRuns />

      <section className="badge-card" aria-label="Your badge">
        <Badge tier={p.badge} />
        <div className="badge-copy">
          <p className="badge-name">{p.badge ? title(p.badge) : 'No badge yet'}</p>
          {next ? (
            <>
              <p className="muted">
                <strong>{km(next - total)} km</strong> to {title(p.next_badge)}
              </p>
              <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100}
                   aria-valuenow={Math.round(progress)} aria-label={`Progress to ${title(p.next_badge)}`}>
                <span style={{ width: `${progress}%` }} />
              </div>
            </>
          ) : (
            <p className="muted">Every milestone earned.</p>
          )}
        </div>
      </section>

      <section aria-labelledby="recent">
        <h2 className="section-title" id="recent">Recent runs</h2>
        {p.recent?.length ? (
          <ol className="runs">
            {p.recent.map((r, i) => (
              <li key={`${r.date}-${i}`}>
                <span>{shortDate(r.date)}</span>
                <span className="run-km">{km(r.km)} km</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">No runs logged yet. Your next Saturday run will show up here.</p>
        )}
      </section>

      <p className="footnote">Totals update every Monday from the run log.</p>
    </div>
  );
}
