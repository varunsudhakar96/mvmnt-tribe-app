import { useEffect, useMemo, useState } from 'react';
import { leaderboard, messageFor } from './api.js';
import { href } from './router.js';

const TIERS = [
  { key: 'VOYAGER', km: 300 }, { key: 'WAYFARER', km: 200 }, { key: 'RANGER', km: 100 },
  { key: 'STRIDER', km: 50 }, { key: 'PACER', km: 25 },
];
const UP = [...TIERS].reverse(); // 25 → 300
const title = (s) => s.charAt(0) + s.slice(1).toLowerCase();
const kmText = (n) => { const v = Number(n || 0); return Number.isInteger(v) ? String(v) : String(+v.toFixed(1)); };
const initials = (n) => String(n || '?').trim().split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase();
const tierOf = (km) => TIERS.find((t) => km >= t.km)?.key || null;
function nextStep(km) {
  const next = UP.find((t) => km < t.km);
  if (!next) return { label: 'Every milestone earned', pct: 100 };
  const prev = [...UP].reverse().find((t) => km >= t.km)?.km ?? 0;
  return { label: `${kmText(next.km - km)} km to ${title(next.key)}`, pct: Math.round(((km - prev) / (next.km - prev)) * 100) };
}

export default function Leaderboard({ profile }) {
  const [data, setData] = useState(undefined);
  const [error, setError] = useState('');
  const [tier, setTier] = useState('ALL');
  const [q, setQ] = useState('');

  const load = () => { setError(''); leaderboard().then(setData).catch((e) => setError(messageFor(e.code))); };
  useEffect(load, []);

  // Competition ranking: equal km share a rank (1, 2, 2, 4).
  const ranked = useMemo(() => {
    const list = (data?.runners || []).map((r) => ({ ...r, km: Number(r.km) }));
    let rank = 0;
    return list.map((r, i) => {
      if (i === 0 || r.km !== list[i - 1].km) rank = i + 1;
      return { ...r, rank, tier: tierOf(r.km) };
    });
  }, [data]);

  const counts = useMemo(() => {
    const c = { ALL: ranked.length, NONE: 0 };
    TIERS.forEach((t) => { c[t.key] = 0; });
    ranked.forEach((r) => { c[r.tier || 'NONE'] += 1; });
    return c;
  }, [ranked]);
  const totalKm = ranked.reduce((s, r) => s + r.km, 0);
  const badges = ranked.filter((r) => r.tier).length;
  const me = ranked.find((r) => r.me);

  const shown = ranked.filter((r) => (tier === 'ALL' || (r.tier || 'NONE') === tier)
    && (!q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase())));
  const chips = [['ALL', 'All'], ...TIERS.map((t) => [t.key, title(t.key)]), ['NONE', 'Under 25 km']].filter(([k]) => k === 'ALL' || counts[k] > 0);

  return (
    <main className="shell">
      <header className="topbar">
        <a className="link back" href={href('')}>‹ Home</a>
        {!profile && <a className="link" href={href('login?next=leaderboard')}>Log in</a>}
      </header>

      <div className="lb-head">
        <p className="eyebrow">Weekend runs · Season 1</p>
        <h1 className="display">Leaderboard</h1>
      </div>

      {error && (
        <div className="stack">
          <p className="error" role="alert">{error}</p>
          <button className="btn" onClick={load}>Try again</button>
        </div>
      )}
      {!error && data === undefined && <p className="muted">Loading runners…</p>}

      {data && (
        <>
          <dl className="lb-stats">
            <div><dt>Runners</dt><dd>{ranked.length}</dd></div>
            <div><dt>Total km</dt><dd>{Math.round(totalKm).toLocaleString('en-IN')}</dd></div>
            <div><dt>Badges</dt><dd>{badges}</dd></div>
          </dl>

          {me && (
            <a className="lb-me" href={href('me')} aria-label="Your runs">
              <span className="lb-me-rank">#{me.rank}</span>
              <span className="lb-me-copy">
                <span className="lb-me-label">You · {kmText(me.km)} km · {me.runs} runs</span>
                <span className="bar" aria-hidden="true"><span style={{ width: `${nextStep(me.km).pct}%` }} /></span>
                <span className="muted small">{nextStep(me.km).label}</span>
              </span>
              {me.tier && <span className={`lb-tier tier-${me.tier.toLowerCase()}`}>{title(me.tier)}</span>}
            </a>
          )}
          {profile && !me && <p className="note">You're not on the board yet. Log a run with the QR and you'll appear here.</p>}

          <div className="lb-chips" role="tablist" aria-label="Filter by milestone">
            {chips.map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tier === k} className={`lb-chip${tier === k ? ' on' : ''}${k !== 'ALL' && k !== 'NONE' ? ` tier-${k.toLowerCase()}` : ''}`}
                      onClick={() => setTier(k)}>
                {label} <span>{counts[k]}</span>
              </button>
            ))}
          </div>
          <input className="input" type="search" placeholder="Search a runner" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search runners" />

          {shown.length === 0 && <p className="muted lb-empty">No runners match.</p>}
          <ol className="lb-list">
            {shown.map((r) => {
              const step = nextStep(r.km);
              return (
                <li key={`${r.rank}-${r.name}`} className={`${r.me ? 'me ' : ''}${r.rank <= 3 ? `top top-${r.rank}` : ''}`}>
                  <span className="lb-rank">{r.rank}</span>
                  <span className="lb-avatar" aria-hidden="true">{initials(r.name)}</span>
                  <span className="lb-copy">
                    <span className="lb-name">{r.name}{r.me && <span className="pill-mini">You</span>}</span>
                    <span className="lb-progress" aria-label={step.label}>
                      <span className="bar"><span style={{ width: `${step.pct}%` }} /></span>
                    </span>
                    <span className="lb-sub">
                      {r.tier ? <span className={`lb-tier tier-${r.tier.toLowerCase()}`}>{title(r.tier)}</span> : null}
                      <span className="muted">{r.runs} {r.runs === 1 ? 'run' : 'runs'}{r.tier ? '' : ` · ${step.label}`}</span>
                    </span>
                  </span>
                  <span className="lb-km"><strong>{kmText(r.km)}</strong><small>km</small></span>
                </li>
              );
            })}
          </ol>
          <p className="footnote">Runs logged with the QR count straight away. Run together, grow together.</p>
        </>
      )}
    </main>
  );
}

// Compact top-3 for the home page.
export function TopRunners() {
  const [top, setTop] = useState(null);
  useEffect(() => { leaderboard().then((d) => setTop((d?.runners || []).slice(0, 3))).catch(() => setTop([])); }, []);
  if (!top || top.length === 0) return null;
  return (
    <section aria-labelledby="top-runners" className="top-runners">
      <div className="section-row">
        <h2 className="section-title" id="top-runners">Leaderboard</h2>
        <a className="link inline" href={href('leaderboard')}>See all ›</a>
      </div>
      <a className="top-card" href={href('leaderboard')}>
        {top.map((r, i) => (
          <span key={r.name} className="top-row">
            <span className="lb-rank">{i + 1}</span>
            <span className="lb-name">{r.name}</span>
            <span className="lb-km"><strong>{kmText(r.km)}</strong><small>km</small></span>
          </span>
        ))}
      </a>
    </section>
  );
}
