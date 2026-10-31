import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { getProfile, logOut, messageFor, uploadAvatar } from './api.js';
import { useRoute, href } from './router.js';
import Wordmark from './Wordmark.jsx';
import Badge from './Badge.jsx';
import { RunPage, ScanPage, CheckInPage, SignupPage, BadgeImg } from './Runs.jsx';
import Landing from './Landing.jsx';
import Avatar from './Avatar.jsx';
const AdminRuns = lazy(() => import('./Admin.jsx').then((m) => ({ default: m.AdminRuns })));
const AdminMembers = lazy(() => import('./Admin.jsx').then((m) => ({ default: m.AdminMembers })));
const AdminBadges = lazy(() => import('./Admin.jsx').then((m) => ({ default: m.AdminBadges })));
const AdminBadgeDetail = lazy(() => import('./Admin.jsx').then((m) => ({ default: m.AdminBadgeDetail })));
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

  // Came back from "Log in to sign up": continue to where they were going.
  useEffect(() => {
    if (parts[0] === 'login') window.location.replace(`#/${query.get('next') || ''}`);
  }, [parts, query]);

  if (profile) {
    const [a, b, c] = parts;
    if (a === 'run' && b && c === 'scan') return <ScanPage id={b} profile={profile} />;
    if (a === 'run' && b && c === 'signup') return <SignupPage id={b} profile={profile} />;
    if (a === 'run' && b && c === 'checkin') return <CheckInPage id={b} code={query.get('c') || ''} onLogged={load} />;
    if (a === 'run' && b) return <RunPage id={b} profile={profile} />;
    if (a === 'admin') {
      if (!profile.is_admin) return <NotAllowed />;
      if (b === 'run' && c) return <Wait><AdminRunEdit id={c} /></Wait>;
      if (b === 'members') return <Wait><AdminMembers /></Wait>;
      if (b === 'badges') return <Wait><AdminBadges /></Wait>;
      if (b === 'badge' && c) return <Wait><AdminBadgeDetail id={c} /></Wait>;
      return <Wait><AdminRuns /></Wait>;
    }
    if (a !== 'me') return <Landing profile={profile} />;
  }
  if (profile === undefined && !error) {
    return parts.length === 0 ? <Landing profile={undefined} /> : <main className="shell"><p className="muted">Loading…</p></main>;
  }

  // ---- Your runs: the metrics page behind the profile photo ----
  return (
    <main className="shell">
      <header className="topbar">
        <a className="link back" href={href('')}>‹ Home</a>
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

      {profile && <ProfileHead p={profile} onChange={load} />}
      {profile && <Dashboard p={profile} />}
    </main>
  );
}

function ProfileHead({ p, onChange }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function pick(e) {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    setBusy(true); setErr('');
    try { await uploadAvatar(f); await onChange(); } catch (x) { setErr(messageFor(x.code)); } finally { setBusy(false); }
  }
  return (
    <div className="profile-head">
      <label className="avatar-edit" aria-label="Change profile photo">
        <Avatar name={p.name} url={p.avatar_url} size={72} />
        <input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={pick} />
        <span className="avatar-pen">{busy ? '…' : p.avatar_url ? 'Change' : 'Add photo'}</span>
      </label>
      {err && <p className="error small" role="alert">{err}</p>}
    </div>
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

      {p.badges?.length > 0 && (
        <section aria-labelledby="earned">
          <h2 className="section-title" id="earned">Program badges · {p.badges.length}</h2>
          <ul className="badge-grid">
            {p.badges.map((b, i) => (
              <li key={`${b.name}-${i}`}>
                <BadgeImg badge={b} size={84} />
                <span className="badge-grid-name">{b.name}</span>
                <span className="muted small">{shortDate(b.on)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

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

      <section aria-labelledby="attended">
        <h2 className="section-title" id="attended">Events & programs{p.attended?.length ? ` · ${p.attended.length}` : ''}</h2>
        {p.attended?.length ? (
          <ol className="att-log">
            {p.attended.map((a) => (
              <li key={a.id}>
                <a href={href(`run/${a.id}`)}>
                  <span className="att-log-copy">
                    <span className="run-name">{a.name}</span>
                    <span className="muted small">
                      {a.kind === 'program' ? 'Program' : 'Event'} · {a.count > 1 && a.first !== a.last ? `${shortDate(a.first)} – ${shortDate(a.last)}` : shortDate(a.last)}
                    </span>
                  </span>
                  <strong className="att-log-n">
                    {a.kind === 'program' && a.classes ? `${Math.min(a.count, a.classes)}/${a.classes}` : '✓'}
                  </strong>
                </a>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">No events yet. Check in at a workshop or program and it shows up here.</p>
        )}
      </section>

      <p className="footnote">Runs logged with the QR count straight away.</p>
    </div>
  );
}
