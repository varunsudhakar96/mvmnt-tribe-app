import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
const Scanner = lazy(() => import('./Scanner.jsx'));
import QRCode from 'qrcode';
import {
  adminListRuns, adminMembers, adminSetPayment, adminSaveRun, adminDeleteRun, adminNewQr, adminAddAttendee, adminRemoveAttendee, uploadPoster, normalisePhone,
  adminEndEvent, adminClearTests, adminListBadges, adminSaveBadge, uploadBadgeImage, adminBadgeDetail, adminFindMembers, adminGiveBadge, adminTakeBadge, signedFileUrls, adminScanTicket, readScan,
  checkinLink, messageFor, runDate, runTime,
} from './api.js';
import { go, href } from './router.js';
import { answerText, ShareButton, BadgeImg } from './Runs.jsx';

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

function AdminTabs({ active }) {
  return (
    <nav className="tabs" aria-label="Admin sections">
      <a className={active === 'runs' ? 'on' : ''} href={href('admin')} aria-current={active === 'runs' ? 'page' : undefined}>Events</a>
      <a className={active === 'members' ? 'on' : ''} href={href('admin/members')} aria-current={active === 'members' ? 'page' : undefined}>Members</a>
      <a className={active === 'badges' ? 'on' : ''} href={href('admin/badges')} aria-current={active === 'badges' ? 'page' : undefined}>Badges</a>
    </nav>
  );
}

// ---------- Members ----------
const ago = (iso) => {
  if (!iso) return '—';
  const d = Math.floor((Date.now() - new Date(iso)) / 864e5);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};
const dayMonth = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—');
const fmtPhone = (p) => (/^\d{10}$/.test(p || '') ? `${p.slice(0, 5)} ${p.slice(5)}` : String(p || '').replace(/^name:/, 'no number · '));

export function AdminMembers() {
  const [data, setData] = useState(undefined);
  const [error, setError] = useState('');
  const [view, setView] = useState('not_joined');
  const [q, setQ] = useState('');
  const [recent, setRecent] = useState(true);
  const [copied, setCopied] = useState('');

  useEffect(() => { adminMembers().then(setData).catch((e) => setError(messageFor(e.code))); }, []);

  const t = data?.totals;
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const match = (p) => !q || `${p.name} ${p.phone}`.toLowerCase().includes(q.toLowerCase());
  const notJoined = (data?.not_joined || []).filter((p) => (!recent || (p.last_run && p.last_run >= cutoff)) && match(p));
  const joined = (data?.joined || []).filter(match);
  const checks = (data?.bad_numbers?.length || 0) + (data?.same_name?.length || 0);

  async function copy(withNumbers) {
    const lines = notJoined.map((p, i) => `${i + 1}. ${p.name}${withNumbers && /^\d{10}$/.test(p.phone) ? ` (${fmtPhone(p.phone)})` : ''}`);
    const textOut = `Haven't joined the Mvmnt Tribe app yet:\n${lines.join('\n')}`;
    try { await navigator.clipboard.writeText(textOut); setCopied(withNumbers ? 'numbers' : 'names'); }
    catch { window.prompt('Copy this list', textOut); }
    setTimeout(() => setCopied(''), 2200);
  }

  return (
    <main className="shell">
      <AdminBar />
      <AdminTabs active="members" />
      <div className="stack">
        <h1 className="display">Members</h1>
        {error && <p className="error" role="alert">{error}</p>}
        {!error && !data && <p className="muted">Loading…</p>}
        {t && (
          <>
            <dl className="tiles">
              <div><dt>Accounts</dt><dd>{t.accounts}</dd><span>of {t.runners} runners</span></div>
              <div><dt>New this week</dt><dd>{t.new_7d}</dd></div>
              <div><dt>Opened this week</dt><dd>{t.active_7d}</dd></div>
              <div><dt>Not joined yet</dt><dd>{t.not_joined}</dd><span>have runs logged</span></div>
            </dl>
            <div className="bar big" role="progressbar" aria-valuemin={0} aria-valuemax={100}
                 aria-valuenow={Math.round((t.accounts / Math.max(1, t.runners)) * 100)} aria-label="Runners on the app">
              <span style={{ width: `${Math.min(100, (t.accounts / Math.max(1, t.runners)) * 100)}%` }} />
            </div>

            <div className="seg" role="tablist" aria-label="Lists">
              <button role="tab" aria-selected={view === 'not_joined'} className={view === 'not_joined' ? 'on' : ''} onClick={() => setView('not_joined')}>Not joined</button>
              <button role="tab" aria-selected={view === 'joined'} className={view === 'joined' ? 'on' : ''} onClick={() => setView('joined')}>Joined</button>
              <button role="tab" aria-selected={view === 'checks'} className={view === 'checks' ? 'on' : ''} onClick={() => setView('checks')}>Check{checks ? ` · ${checks}` : ''}</button>
            </div>

            {view !== 'checks' && (
              <input className="input" type="search" placeholder="Search name or number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search members" />
            )}

            {view === 'not_joined' && (
              <section aria-label="Runners not on the app yet" className="stack tight">
                <label className="check">
                  <input type="checkbox" checked={recent} onChange={(e) => setRecent(e.target.checked)} />
                  <span>Only people who ran in the last 30 days</span>
                </label>
                <div className="row">
                  <button className="btn ghost half" onClick={() => copy(false)} disabled={!notJoined.length}>{copied === 'names' ? 'Copied' : 'Copy names'}</button>
                  <button className="btn ghost half" onClick={() => copy(true)} disabled={!notJoined.length}>{copied === 'numbers' ? 'Copied' : 'Copy with numbers'}</button>
                </div>
                <p className="hint">{notJoined.length} {notJoined.length === 1 ? 'person' : 'people'} · most recent runners first</p>
                <ol className="su-list">
                  {notJoined.map((p) => (
                    <li key={`${p.phone}-${p.name}`}>
                      <div className="su-row"><span>{p.name}</span><strong className="tabular">{Number(p.km)} km</strong></div>
                      <span className="muted small">{fmtPhone(p.phone)} · {p.runs} runs · last ran {dayMonth(p.last_run)}</span>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {view === 'joined' && (
              <section aria-label="Runners on the app">
                <p className="hint">{joined.length} {joined.length === 1 ? 'account' : 'accounts'} · newest first</p>
                <ol className="su-list">
                  {joined.map((p) => (
                    <li key={`${p.phone}-${p.name}`}>
                      <div className="su-row"><span>{p.name}</span><strong className="tabular">{Number(p.km)} km</strong></div>
                      <span className="muted small">{fmtPhone(p.phone)} · joined {ago(p.joined)} · last opened {ago(p.last_seen)}</span>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {view === 'checks' && (
              <section className="stack tight" aria-label="Profiles to check">
                <h2 className="section-title">Same name, different numbers</h2>
                <p className="hint">Usually one person with a typo in one entry, so their runs are split. Could also be two different people.</p>
                {(data.same_name || []).length === 0 && <p className="muted">None.</p>}
                {(data.same_name || []).map((g) => (
                  <div className="check-card" key={g.name}>
                    {g.people.map((p) => (
                      <div className="su-row" key={p.phone}>
                        <span>{p.name} <span className="muted">· {fmtPhone(p.phone)}</span>{p.joined && <span className="pill-mini">on app</span>}</span>
                        <strong className="tabular">{Number(p.km)} km</strong>
                      </div>
                    ))}
                  </div>
                ))}
                <h2 className="section-title">Missing or broken numbers</h2>
                <p className="hint">These runners can't log in or be matched until they have a proper 10-digit number.</p>
                {(data.bad_numbers || []).length === 0 && <p className="muted">None.</p>}
                <ol className="su-list">
                  {(data.bad_numbers || []).map((p) => (
                    <li key={`${p.phone}-${p.name}`}>
                      <div className="su-row"><span>{p.name}</span><strong className="tabular">{Number(p.km)} km</strong></div>
                      <span className="muted small">{fmtPhone(p.phone)}</span>
                    </li>
                  ))}
                </ol>
                <p className="hint">To merge or fix any of these, tell Claude the names and which number is right.</p>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}

// ---------- Badges ----------
export function AdminBadges() {
  const [badges, setBadges] = useState(undefined);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  useEffect(() => { adminListBadges().then(setBadges).catch((e) => setError(messageFor(e.code))); }, []);
  return (
    <main className="shell">
      <AdminBar />
      <AdminTabs active="badges" />
      <div className="stack">
        <h1 className="display">Badges</h1>
        <p className="muted">Program badges are given automatically when someone finishes every class. You can also give any badge by hand, for example to people who finished a program before the app.</p>
        {!adding
          ? <button className="btn" onClick={() => setAdding(true)}>+ New badge</button>
          : <NewBadgeForm onCancel={() => setAdding(false)} onSaved={(b) => go(`admin/badge/${b.id}`)} />}
        {error && <p className="error" role="alert">{error}</p>}
        {!error && badges === undefined && <p className="muted">Loading…</p>}
        {badges && badges.length === 0 && <p className="muted">No badges yet. Add one, or create it while setting up a program.</p>}
        {badges && badges.length > 0 && (
          <ul className="admin-list">
            {badges.map((b) => (
              <li key={b.id}>
                <a href={href(`admin/badge/${b.id}`)}>
                  <span className="badge-row">
                    <BadgeImg badge={b} size={48} />
                    <span className="badge-row-copy">
                      <span className="run-name">{b.name}</span>
                      <span className="muted">{b.awarded} {b.awarded === 1 ? 'person has it' : 'people have it'}{b.programs ? ` · used in ${b.programs} ${b.programs === 1 ? 'program' : 'programs'}` : ''}</span>
                    </span>
                  </span>
                  <span className="chev" aria-hidden="true">›</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

export function AdminBadgeDetail({ id }) {
  const [badge, setBadge] = useState(undefined);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  const [note, setNote] = useState('');
  const [on, setOn] = useState(today());
  const [newPerson, setNewPerson] = useState(false);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [needName, setNeedName] = useState(false);
  const [notice, setNotice] = useState('');
  const [takeAsk, setTakeAsk] = useState('');

  useEffect(() => { adminBadgeDetail(id).then(setBadge).catch((e) => setError(messageFor(e.code))); }, [id]);
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return undefined; }
    const t = setTimeout(() => { adminFindMembers(q, id).then(setFound).catch(() => setFound([])); }, 250);
    return () => clearTimeout(t);
  }, [q, id]);

  async function give(args, who) {
    setBusy(args.memberId || 'phone'); setError(''); setNotice('');
    try {
      setBadge(await adminGiveBadge(id, { ...args, note, on }));
      setNotice(`${who} now has ${badge.name}.`);
      setFound((list) => list.map((m) => (m.member_id === args.memberId ? { ...m, has_badge: true } : m)));
      if (!args.memberId) { setPhone(''); setName(''); setNeedName(false); setNewPerson(false); }
    } catch (e) {
      if (e.code === 'name_needed') setNeedName(true);
      setError(messageFor(e.code));
    } finally { setBusy(''); }
  }
  async function take(m) {
    setBusy(m.member_id); setError(''); setNotice('');
    try { setBadge(await adminTakeBadge(id, m.member_id)); setTakeAsk(''); setNotice(`Took ${badge.name} back from ${m.name}.`); }
    catch (e) { setError(messageFor(e.code)); } finally { setBusy(''); }
  }

  if (!badge) {
    return (
      <main className="shell">
        <AdminBar back="admin/badges" label="‹ Badges" />
        {error ? <p className="error" role="alert">{error}</p> : <p className="muted">Loading…</p>}
      </main>
    );
  }
  const holders = badge.holders || [];
  return (
    <main className="shell">
      <AdminBar back="admin/badges" label="‹ Badges" />
      <div className="stack">
        <div className="badge-hero">
          <BadgeImg badge={badge} size={96} />
          <div>
            <h1 className="display">{badge.name}</h1>
            <p className="muted">{holders.length} {holders.length === 1 ? 'person has it' : 'people have it'}</p>
          </div>
        </div>
        {badge.programs.length > 0 && (
          <p className="hint">Given automatically for finishing: {badge.programs.map((p) => `${p.name}${p.classes ? ` (${p.classes} classes)` : ''}`).join(', ')}.</p>
        )}

        <section className="builder" aria-labelledby="give-h">
          <h2 className="section-title" id="give-h">Give this badge</h2>
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a name or number" aria-label="Search members" />
          {q.trim().length >= 2 && found.length === 0 && <p className="muted small">Nobody found. Check the spelling, or add them by number below.</p>}
          {found.length > 0 && (
            <ul className="find-list">
              {found.map((m) => (
                <li key={m.member_id}>
                  <span className="find-copy">
                    <span>{m.name}{m.on_app && <span className="pill-mini">on app</span>}</span>
                    <span className="muted small">{fmtPhone(m.phone)}</span>
                  </span>
                  {m.has_badge
                    ? <span className="signed-tag">✓ Has it</span>
                    : <button className="btn small-btn" disabled={!!busy} onClick={() => give({ memberId: m.member_id }, m.name)}>{busy === m.member_id ? '…' : 'Give'}</button>}
                </li>
              ))}
            </ul>
          )}
          <div className="two">
            <label className="field">
              <span className="label">Earned on</span>
              <input className="input" type="date" value={on} max={today()} onChange={(e) => setOn(e.target.value)} />
            </label>
            <label className="field">
              <span className="label">Note</span>
              <input className="input" value={note} maxLength={120} onChange={(e) => setNote(e.target.value)} placeholder="Sept batch" />
            </label>
          </div>
          <span className="hint">The date and note apply to everyone you give it to from this screen. The member sees the badge and date on their profile.</span>
          {!newPerson ? (
            <button type="button" className="link inline" onClick={() => setNewPerson(true)}>Not in the list? Add by number</button>
          ) : (
            <div className="stack tight add-att">
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
              <button className="btn" disabled={busy === 'phone'} onClick={() => {
                const p = normalisePhone(phone);
                if (!p) { setError(messageFor('invalid_phone')); return; }
                give({ phone: p, name }, name || fmtPhone(p));
              }}>{busy === 'phone' ? 'Giving…' : 'Give badge'}</button>
              <button type="button" className="link" onClick={() => { setNewPerson(false); setNeedName(false); setError(''); }}>Cancel</button>
            </div>
          )}
          {notice && !error && <p className="saved" role="status">{notice}</p>}
          {error && <p className="error" role="alert">{error}</p>}
        </section>

        <section aria-labelledby="holders-h">
          <h2 className="section-title" id="holders-h">Who has it · {holders.length}</h2>
          {holders.length === 0 && <p className="muted">Nobody yet.</p>}
          <ol className="su-list">
            {holders.map((m) => (
              <li key={m.member_id}>
                <div className="su-row">
                  <span>{m.name}</span>
                  {takeAsk === m.member_id ? (
                    <span className="att-right">
                      <button className="link inline danger-link" onClick={() => take(m)} disabled={busy === m.member_id}>Yes, take back</button>
                      <button className="link inline" onClick={() => setTakeAsk('')}>Keep</button>
                    </span>
                  ) : (
                    <button className="link inline" onClick={() => setTakeAsk(m.member_id)} aria-label={`Take back from ${m.name}`}>Take back</button>
                  )}
                </div>
                <span className="muted small">
                  {fmtPhone(m.phone)} · {dayMonth(m.on)} · {m.how === 'auto' ? `finished ${m.note || 'the program'}` : `given by you${m.note ? ` · ${m.note}` : ''}`}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
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
      <AdminTabs active="runs" />
      <div className="stack">
        <h1 className="display">Events</h1>
        <a className="btn" href={href('admin/run/new')}>Add an event</a>
        {error && <p className="error" role="alert">{error}</p>}
        {!error && runs === undefined && <p className="muted">Loading…</p>}
        {runs && (
          <>
            <AdminGroup title="Upcoming & running" runs={upcoming} empty="Nothing scheduled. Add the next one." />
            {past.length > 0 && <AdminGroup title="Past events" runs={past.slice(0, 20)} />}
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
                  {[r.kind === 'program' ? `${r.check_in_live || r.is_past ? 'Started' : 'Starts'} ${runDate(r.date)}` : runDate(r.date),
                    r.kind === 'program' && r.classes ? `${r.classes} classes` : runTime(r.time), r.venue].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className="flags">
                {r.is_today && r.kind !== 'program' && !r.ended && <span className="today">Today</span>}
                {r.ended && <span className="flag flag-ended">Ended</span>}
                {r.published === false && <span className="flag flag-draft">Draft</span>}
                <span className="kind-tag">{KIND_LABEL[r.kind] || 'Run'}</span>
                {r.signup_count > 0 && <span className="count">{r.signup_count} signed up</span>}
                {r.pending_count > 0 && <span className="flag flag-pending">{r.pending_count} pending</span>}
                {r.attendees?.length > 0 && <span className="count">{r.kind === 'program' ? `${new Set(r.attendees.map((a) => a.member_id)).size} attending` : `${r.attendees.length} checked in`}</span>}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- Add / edit ----------
const EMPTY = { kind: 'run', name: '', date: '', time: '06:00', venue: '', map_url: '', description: '', run_km: '5', poster_url: '',
  signup_enabled: true, signup_fields: [], capacity: '', price: '', payment_qr_url: '', upi_id: '', classes: '', badge_id: '', payment_mode: 'online', pay_at_venue: false, checkin_mode: 'venue_qr', published: true };
const CHECKIN = [['venue_qr', 'They scan the venue QR'], ['ticket', 'You scan their ticket'], ['both', 'Either']];
const KIND_LABEL = { run: 'Run', event: 'Event', program: 'Program' };
const KIND_HINT = {
  run: "Check-ins log km toward runners' totals and badges.",
  event: 'One-day workshops, socials, anything else. Check-in records attendance; no km.',
  program: 'A course of classes, e.g. 4 weeks of Animal Flow. People check in at every class; finishing them all can earn a badge.',
};
const LAST_FIELDS = 'mvmnt.lastSignupFields';
const lastFields = () => { try { return JSON.parse(recall(LAST_FIELDS) || '[]').map((f) => ({ ...f, id: newId() })); } catch { return []; } };
const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
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
  const payRef = useRef(null);
  const kind = form?.kind || 'run';
  const isEvent = kind !== 'run';
  const isProgram = kind === 'program';
  const noun = kind;
  const [endAsk, setEndAsk] = useState(false);
  const [publishAsk, setPublishAsk] = useState(false); // going live with test sign-ups present: clear or keep?
  const goingLive = !isNew && saved && saved.published === false && form?.published;

  useEffect(() => {
    if (isNew) return;
    adminListRuns()
      .then((all) => {
        const r = all.find((x) => x.id === id);
        if (!r) { setError(messageFor('run_not_found')); return; }
        setSaved(r);
        setForm({ ...EMPTY, ...Object.fromEntries(Object.keys(EMPTY).map((k) => [k, r[k] ?? ''])),
                  price: r.price ? String(r.price) : '', kind: r.kind || 'run',
                  classes: r.classes ? String(r.classes) : '', badge_id: r.badge_id || '', payment_mode: r.payment_mode || 'manual', pay_at_venue: !!r.pay_at_venue, checkin_mode: r.checkin_mode || 'venue_qr', published: r.published !== false });
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

  async function pickPayQr(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(''); setBusy('payqr');
    try { const url = await uploadPoster(file); setForm((f) => ({ ...f, payment_qr_url: url })); }
    catch (err) { setError(messageFor(err.code)); }
    finally { setBusy(''); }
  }

  async function save(e, keepTests) {
    e?.preventDefault?.();
    if (goingLive && saved.test_count > 0 && keepTests === undefined) { setPublishAsk(true); return; }
    setPublishAsk(false);
    setError(''); setNotice(''); setBusy('save');
    try {
      const r = await adminSaveRun({ ...form, id: isNew ? null : id, keep_tests: !!keepTests });
      if (r.run_km) remember(LAST_KM, String(r.run_km));
      remember(LAST_FIELDS, JSON.stringify(r.signup_fields || []));
      setForm((f) => ({ ...f, signup_fields: r.signup_fields || [] }));
      setSaved(r);
      if (isNew) { go(`admin/run/${r.id}`); }
      setNotice(r.published === false ? 'Saved as a draft. Only people with the link can open it.' : 'Saved. Members can see it now.');
    } catch (err) {
      setError(messageFor(err.code));
    } finally {
      setBusy('');
    }
  }

  async function endIt(end) {
    setBusy('end'); setError('');
    try { setSaved(await adminEndEvent(id, end)); setEndAsk(false); setNotice(end ? 'Ended. It now shows under Past events.' : 'Reopened.'); }
    catch (err) { setError(messageFor(err.code)); }
    finally { setBusy(''); }
  }

  async function clearTests() {
    setBusy('tests'); setError('');
    try { setSaved(await adminClearTests(id)); setNotice('Test sign-ups cleared.'); }
    catch (err) { setError(messageFor(err.code)); }
    finally { setBusy(''); }
  }

  async function remove() {
    setBusy('delete');
    try { await adminDeleteRun(id); go('admin'); } catch (err) { setError(messageFor(err.code)); setBusy(''); }
  }

  if (!form) {
    return (
      <main className="shell">
        <AdminBar back="admin" label="‹ Events" />
        {error ? <p className="error" role="alert">{error}</p> : <p className="muted">Loading…</p>}
      </main>
    );
  }

  return (
    <main className="shell">
      <AdminBar back="admin" label="‹ Events" />
      <form className="stack" onSubmit={save} noValidate>
        <div className="title-row">
          <h1 className="display">{isNew ? `New ${noun}` : `Edit ${noun}`}</h1>
          {!isNew && saved && <ShareButton run={saved} />}
        </div>

        <fieldset className="field type-pick">
          <legend className="label">What is it?</legend>
          <div className="seg three-seg" role="radiogroup">
            {['run', 'event', 'program'].map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''}
                      onClick={() => setForm((f) => ({ ...f, kind: k }))}>{KIND_LABEL[k]}</button>
            ))}
          </div>
          <span className="hint">{KIND_HINT[kind]}</span>
        </fieldset>

        <div className="field">
          <span className="label">Poster</span>
          <button type="button" className={`poster-pick${form.poster_url ? ' has' : ''}`}
                  onClick={() => fileRef.current?.click()} disabled={busy === 'poster'}>
            {form.poster_url
              ? <img src={form.poster_url} alt="Poster" />
              : <span>{busy === 'poster' ? 'Uploading…' : 'Add a poster or photo'}</span>}
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

        <Field label="Title" required>
          <input className="input" value={form.name} onChange={set('name')} placeholder={isProgram ? 'Animal Flow Level 1 · 4 weeks' : isEvent ? 'Mudgar Workshop' : 'Saturday 5K'} required />
        </Field>
        <div className="two">
          <Field label={isProgram ? 'First class' : 'Date'} required>
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
        <Field label="Details" hint={isEvent ? 'Optional: what happens, who it is for, what to bring.' : 'Optional: route, distance, what to bring.'}>
          <textarea className="input area" rows={3} value={form.description} onChange={set('description')} />
        </Field>
        {isProgram && (
          <section className="builder" aria-labelledby="prog-h">
            <h2 className="section-title" id="prog-h">Program</h2>
            <Field label="Number of classes" required hint="How many times people check in to complete it, e.g. 4 for a once-a-week, 4-week program. One check-in per person per day.">
              <input className="input" inputMode="numeric" value={form.classes ?? ''} placeholder="4"
                     onChange={(e) => setForm((f) => ({ ...f, classes: e.target.value.replace(/\D/g, '').slice(0, 3) }))} />
            </Field>
            <BadgePicker value={form.badge_id} classes={form.classes} onChange={(v) => setForm((f) => ({ ...f, badge_id: v }))} />
          </section>
        )}

        <SignupBuilder form={form} setForm={setForm} hasSignups={(saved?.signup_count || 0) > 0} />

        <fieldset className="field type-pick">
          <legend className="label">How do people check in?</legend>
          <div className="seg three-seg checkin-seg" role="radiogroup">
            {CHECKIN.map(([v, l]) => (
              <button key={v} type="button" role="radio" aria-checked={form.checkin_mode === v} className={form.checkin_mode === v ? 'on' : ''}
                      onClick={() => setForm((f) => ({ ...f, checkin_mode: v }))}>{l}</button>
            ))}
          </div>
          <span className="hint">{form.checkin_mode === 'ticket'
            ? 'Everyone who signs up gets a ticket with a QR. At the door you tap Scan tickets and point your camera at each one. No venue QR needed.'
            : form.checkin_mode === 'both' ? 'You can scan tickets at the door, and people can also scan the venue QR themselves.'
            : 'You print the venue QR; people open the app and scan it to check in.'}</span>
        </fieldset>

        {!isEvent && (
          <Field label="Distance (km)" hint="What a QR check-in logs by default. Runners can change it if they ran more or less.">
            <input className="input" inputMode="decimal" value={form.run_km ?? ''} placeholder="5"
                   onChange={(e) => setForm((f) => ({ ...f, run_km: e.target.value.replace(/[^0-9.]/g, '').slice(0, 5) }))} />
          </Field>
        )}

        <section className="builder" aria-labelledby="pay-h">
          <h2 className="section-title" id="pay-h">Payment</h2>
          <Field label="Price (₹)" hint="Leave empty for free. When there's a price, people see the payment QR after signing up.">
            <input className="input" inputMode="numeric" value={form.price ?? ''} placeholder="Free"
                   onChange={(e) => setForm((f) => ({ ...f, price: e.target.value.replace(/\D/g, '').slice(0, 6) }))} />
          </Field>
          {Number(form.price) > 0 && (
            <fieldset className="field type-pick">
              <legend className="label">How do people pay?</legend>
              <div className="seg two-seg" role="radiogroup">
                <button type="button" role="radio" aria-checked={form.payment_mode === 'online'} className={form.payment_mode === 'online' ? 'on' : ''}
                        onClick={() => setForm((f) => ({ ...f, payment_mode: 'online' }))}>In the app</button>
                <button type="button" role="radio" aria-checked={form.payment_mode !== 'online'} className={form.payment_mode !== 'online' ? 'on' : ''}
                        onClick={() => setForm((f) => ({ ...f, payment_mode: 'manual' }))}>UPI QR</button>
              </div>
              <span className="hint">{form.payment_mode === 'online'
                ? 'Razorpay: UPI, cards, netbanking. The spot is booked only when the payment goes through. Razorpay keeps about 2.36%.'
                : 'People sign up, pay your UPI QR and tap "I\'ve paid"; you mark each one paid. No fees.'}</span>
            </fieldset>
          )}
          {Number(form.price) > 0 && form.payment_mode === 'online' && (
            <label className="toggle-row">
              <input type="checkbox" checked={!!form.pay_at_venue} onChange={(e) => setForm((f) => ({ ...f, pay_at_venue: e.target.checked }))} />
              <span>
                <strong>Allow pay at the venue</strong>
                <small>Adds a second button: "Sign up, pay at the venue". Those people hold a spot and show as "Pay at venue" until you mark them paid.</small>
              </span>
            </label>
          )}
          {Number(form.price) > 0 && form.payment_mode !== 'online' && (
            <>
              <div className="field">
                <span className="label">Payment QR</span>
                <button type="button" className={`poster-pick qr-pick${form.payment_qr_url ? ' has' : ''}`}
                        onClick={() => payRef.current?.click()} disabled={busy === 'payqr'}>
                  {form.payment_qr_url
                    ? <img src={form.payment_qr_url} alt="Payment QR" />
                    : <span>{busy === 'payqr' ? 'Uploading…' : 'Add your UPI QR image'}</span>}
                </button>
                <input ref={payRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={pickPayQr} />
                {form.payment_qr_url && (
                  <div className="row">
                    <button type="button" className="link inline" onClick={() => payRef.current?.click()}>Change QR</button>
                    <button type="button" className="link inline" onClick={() => setForm((f) => ({ ...f, payment_qr_url: '' }))}>Remove</button>
                  </div>
                )}
              </div>
              <Field label="UPI ID" hint="Recommended. People view the QR on their own phone, so they can't scan it; this gives them a Pay with UPI app button.">
                <input className="input" value={form.upi_id ?? ''} onChange={set('upi_id')} placeholder="mvmnttribe@okhdfc" autoCapitalize="off" autoCorrect="off" />
              </Field>
            </>
          )}
        </section>

        <section className="builder" aria-labelledby="vis-h">
          <h2 className="section-title" id="vis-h">Visibility</h2>
          <label className="toggle-row live-toggle">
            <input type="checkbox" checked={!!form.published} onChange={(e) => { setForm((f) => ({ ...f, published: e.target.checked })); setPublishAsk(false); }} />
            <span>
              <strong>{form.published ? 'Active · live for members' : 'Draft · hidden from members'}</strong>
              <small>{form.published
                ? 'Listed under Events and on the home page. Switch off to take it down without deleting it.'
                : 'Not listed anywhere, but anyone with the link can open it, sign up, pay (a test payment, no money moves) and be checked in. Those are test entries: they don\'t count for km or badges and are cleared when you go live.'}</small>
            </span>
          </label>
          {!form.published && !isNew && saved && (
            <div className="stack tight preview-box">
              <span className="label">Preview link</span>
              <ShareButton run={saved} label="Share preview link" />
              {saved.test_count > 0 && (
                <p className="muted small">{saved.test_count} test {saved.test_count === 1 ? 'entry' : 'entries'} so far.{' '}
                  <button type="button" className="link inline" onClick={clearTests} disabled={busy === 'tests'}>{busy === 'tests' ? 'Clearing…' : 'Clear them'}</button>
                </p>
              )}
            </div>
          )}
        </section>

        {error && <p className="error" role="alert">{error}</p>}
        {notice && !error && <p className="saved" role="status">{notice}</p>}
        {publishAsk ? (
          <div className="stack tight publish-ask" role="group" aria-label="Going live">
            <p className="muted">Going live. There {saved.test_count === 1 ? 'is 1 test entry' : `are ${saved.test_count} test entries`} on this {noun}. Clear them so it starts clean?</p>
            <button className="btn" type="button" onClick={(e) => save(e, false)} disabled={!!busy}>{busy === 'save' ? 'Saving…' : 'Clear tests & go live'}</button>
            <button className="btn ghost" type="button" onClick={(e) => save(e, true)} disabled={!!busy}>Keep them as real sign-ups</button>
            <button className="link" type="button" onClick={() => setPublishAsk(false)}>Cancel</button>
          </div>
        ) : (
          <button className="btn" type="submit" disabled={!!busy}>
            {busy === 'save' ? 'Saving…' : isNew ? (form.published ? `Publish ${noun}` : 'Save draft') : goingLive ? 'Save & go live' : 'Save changes'}
          </button>
        )}
      </form>

      {!isNew && saved && <Attendance run={saved} onChange={setSaved} />}
      {!isNew && saved && <Signups run={saved} onChange={setSaved} />}
      {!isNew && saved && !saved.ended && saved.checkin_mode !== 'venue_qr' && (
        <section className="qr-card" aria-labelledby="scan-h">
          <h2 className="section-title" id="scan-h">Scan tickets</h2>
          <p className="muted">At the door, point your camera at each person's ticket QR. It checks them in and tells you if money is due.</p>
          <a className="btn" href={href(`admin/scan?e=${saved.id}`)}>Scan tickets</a>
        </section>
      )}
      {!isNew && saved && !saved.ended && saved.checkin_mode !== 'ticket' && <VenueQr run={saved} onChange={setSaved} />}

      {!isNew && saved && (
        <section className="end-zone" aria-labelledby="end-h">
          <h2 className="section-title" id="end-h">{saved.ended ? 'Ended' : `End this ${noun}`}</h2>
          {saved.ended ? (
            <>
              <p className="muted">Ended on {runDate(saved.ended_on)}. It shows under Past events, with no Sign up or Check in buttons.</p>
              <button className="btn ghost" onClick={() => endIt(false)} disabled={busy === 'end'}>{busy === 'end' ? 'Working…' : 'Reopen it'}</button>
            </>
          ) : !endAsk ? (
            <>
              <p className="muted">{isProgram ? 'When the last class is done, end the program.' : 'Once it’s over, end it.'} It moves to Past events and sign-ups and check-ins close.{isProgram ? ' Badges already earned stay.' : ''}</p>
              <button className="btn ghost" onClick={() => setEndAsk(true)}>End {noun}</button>
            </>
          ) : (
            <div className="stack">
              <p className="muted">End “{form.name}” now? You can reopen it later if you need to.</p>
              <button className="btn" onClick={() => endIt(true)} disabled={busy === 'end'}>{busy === 'end' ? 'Ending…' : `Yes, end the ${noun}`}</button>
              <button className="btn ghost" onClick={() => setEndAsk(false)}>Not yet</button>
            </div>
          )}
        </section>
      )}

      {!isNew && (
        <section className="danger-zone">
          {!confirmDelete ? (
            <button className="link" onClick={() => setConfirmDelete(true)}>Delete this {noun}</button>
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

// ---------- Badge picker (badges are saved and reusable) ----------
function NewBadgeForm({ onSaved, onCancel }) {
  const [name, setName] = useState('');
  const [img, setImg] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const fileRef = useRef(null);
  async function pick(e) {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    setBusy('img'); setError('');
    try { setImg(await uploadBadgeImage(file)); } catch (err) { setError(messageFor(err.code)); } finally { setBusy(''); }
  }
  async function save() {
    setBusy('save'); setError('');
    try { onSaved(await adminSaveBadge({ name, image_url: img })); }
    catch (err) { setError(messageFor(err.code)); } finally { setBusy(''); }
  }
  return (
    <div className="new-badge stack tight">
      <div className="new-badge-row">
        <button type="button" className={`badge-drop${img ? ' has' : ''}`} onClick={() => fileRef.current?.click()} disabled={busy === 'img'} aria-label="Badge image">
          {img ? <img src={img} alt="New badge" /> : <span>{busy === 'img' ? 'Uploading…' : 'Add image'}</span>}
        </button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={pick} />
        <label className="field grow">
          <span className="label">Badge name</span>
          <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Animal Flow · Level 1" />
        </label>
      </div>
      <span className="hint">A square PNG with a transparent background looks best. Saved badges can be reused for later programs.</span>
      <button type="button" className="btn" onClick={save} disabled={!!busy}>{busy === 'save' ? 'Saving…' : 'Save badge'}</button>
      <button type="button" className="link" onClick={onCancel}>Cancel</button>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

function BadgePicker({ value, classes, onChange }) {
  const [badges, setBadges] = useState(undefined);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { adminListBadges().then(setBadges).catch((e) => { setBadges([]); setError(messageFor(e.code)); }); }, []);

  const chosen = (badges || []).find((b) => b.id === value);
  return (
    <div className="field">
      <span className="label">Badge for finishing</span>
      <span className="hint">
        {chosen
          ? `Given automatically to anyone who checks in to all ${classes || 'the'} classes.`
          : 'Optional. Pick a saved badge or add a new one. It’s given automatically to everyone who completes every class.'}
      </span>
      {badges === undefined && <p className="muted">Loading badges…</p>}
      {badges && (
        <div className="badge-pick" role="radiogroup" aria-label="Badge">
          <button type="button" role="radio" aria-checked={!value} className={`badge-opt${!value ? ' on' : ''}`} onClick={() => onChange('')}>
            <span className="badge-img none"><span>—</span></span>
            <span className="badge-opt-name">No badge</span>
          </button>
          {badges.map((b) => (
            <button type="button" role="radio" key={b.id} aria-checked={value === b.id} className={`badge-opt${value === b.id ? ' on' : ''}`} onClick={() => onChange(b.id)}>
              <BadgeImg badge={b} size={56} />
              <span className="badge-opt-name">{b.name}</span>
              {b.awarded > 0 && <span className="muted small">{b.awarded} earned</span>}
            </button>
          ))}
        </div>
      )}
      {!adding ? (
        <button type="button" className="btn ghost" onClick={() => setAdding(true)}>+ New badge</button>
      ) : (
        <NewBadgeForm onCancel={() => setAdding(false)}
                      onSaved={(b) => { setBadges((list) => [b, ...(list || [])]); onChange(b.id); setAdding(false); }} />
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
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
  ['file', 'File upload'],
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
              {q.type === 'file' && <span className="hint">People upload a photo or PDF (up to 10 MB). Only you can open the files, from the sign-up list.</span>}
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
const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); // IST

function Attendance({ run, onChange }) {
  if (run.kind === 'program') return <ProgramAttendance run={run} onChange={onChange} />;
  return <DayAttendance run={run} onChange={onChange} />;
}

function AddAttendee({ run, onChange, withDate = false }) {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [km, setKm] = useState('');
  const [date, setDate] = useState(today());
  const [needName, setNeedName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  async function add(e) {
    e.preventDefault();
    const p = normalisePhone(phone);
    if (!p) { setError(messageFor('invalid_phone')); return; }
    setBusy(true); setError('');
    try {
      onChange(await adminAddAttendee(run.id, p, km ? Number(km) : null, name, withDate ? date : null));
      setPhone(''); setName(''); setKm(''); setNeedName(false); setOpen(false);
    } catch (err) {
      if (err.code === 'name_needed') setNeedName(true);
      setError(messageFor(err.code));
    } finally { setBusy(false); }
  }
  if (!open) return <button className="btn ghost" onClick={() => setOpen(true)}>+ Add someone who couldn't scan</button>;
  return (
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
      {withDate && (
        <label className="field">
          <span className="label">Class date</span>
          <input className="input" type="date" value={date} min={run.date} max={today()} onChange={(e) => setDate(e.target.value)} />
        </label>
      )}
      {run.kind === 'run' && (
        <label className="field">
          <span className="label">Distance (km)</span>
          <input className="input" inputMode="decimal" value={km} placeholder={String(run.run_km ?? 5)}
                 onChange={(e) => setKm(e.target.value.replace(/[^0-9.]/g, '').slice(0, 5))} />
        </label>
      )}
      <button className="btn" type="submit" disabled={busy}>{busy ? 'Adding…' : 'Check them in'}</button>
      <button type="button" className="link" onClick={() => { setOpen(false); setError(''); setNeedName(false); }}>Cancel</button>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

function ProgramAttendance({ run, onChange }) {
  const list = run.attendees || [];
  const total = Number(run.classes || 0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const people = Object.values(list.reduce((acc, a) => {
    const p = acc[a.member_id] || (acc[a.member_id] = { member_id: a.member_id, name: a.name, phone: a.phone, dates: [], badge: a.badge });
    p.dates.push(a.date); return acc;
  }, {})).map((p) => ({ ...p, dates: [...p.dates].sort() })).sort((x, y) => y.dates.length - x.dates.length || x.name.localeCompare(y.name));
  const byDay = Object.entries(list.reduce((acc, a) => ({ ...acc, [a.date]: (acc[a.date] || 0) + 1 }), {})).sort();
  const finished = total ? people.filter((p) => p.dates.length >= total).length : 0;

  async function remove(m, d) {
    setBusy(`${m}-${d}`); setError('');
    try { onChange(await adminRemoveAttendee(run.id, m, d)); } catch (err) { setError(messageFor(err.code)); } finally { setBusy(''); }
  }

  return (
    <section className="signups" aria-labelledby="att-title">
      <h2 className="section-title" id="att-title">Attendance · {people.length} {people.length === 1 ? 'person' : 'people'}</h2>
      {byDay.length > 0 && (
        <p className="hint">
          {byDay.length} {byDay.length === 1 ? 'class' : 'classes'} so far: {byDay.map(([d, n]) => `${dayMonth(d)} (${n})`).join(', ')}.
          {total ? ` ${finished} finished all ${total}.` : ''}
        </p>
      )}
      {people.length === 0 && <p className="muted">{run.check_in_live ? 'Nobody has checked in yet.' : 'Check-ins open at the first class.'}</p>}
      {people.length > 0 && (
        <ol className="su-list">
          {people.map((p) => (
            <li key={p.member_id}>
              <div className="su-row">
                <span>{p.name}{p.badge && <span className="pill-mini badge-pill">badge ✓</span>}</span>
                <strong className="tabular">{total ? `${Math.min(p.dates.length, total)}/${total}` : p.dates.length}</strong>
              </div>
              <span className="muted small">{p.phone}</span>
              <div className="date-chips">
                {p.dates.map((d) => (
                  <span key={d} className="date-chip">
                    {dayMonth(d)}
                    <button className="chip-x" onClick={() => remove(p.member_id, d)} disabled={busy === `${p.member_id}-${d}`}
                            aria-label={`Remove ${p.name}'s check-in on ${dayMonth(d)}`}>×</button>
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}
      {!run.ended && <AddAttendee run={run} onChange={onChange} withDate />}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

function DayAttendance({ run, onChange }) {
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
      {list.length === 0 && <p className="muted">{run.is_past || run.is_today ? 'Nobody has checked in.' : 'Check-ins open on the day.'}</p>}
      {list.length > 0 && (
        <ol className="su-list">
          {list.map((p) => (
            <li key={p.member_id}>
              <div className="su-row">
                <span>{p.name}{p.by === 'admin check-in' && <span className="muted"> · added by you</span>}</span>
                <span className="att-right">
                  {p.km != null && <strong className="tabular">{Number(p.km)} km</strong>}
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
          {run.kind !== 'event' && (
            <label className="field">
              <span className="label">Distance (km)</span>
              <input className="input" inputMode="decimal" value={km} placeholder={String(run.run_km ?? 5)}
                     onChange={(e) => setKm(e.target.value.replace(/[^0-9.]/g, '').slice(0, 5))} />
            </label>
          )}
          <button className="btn" type="submit" disabled={busy === 'add'}>{busy === 'add' ? 'Adding…' : 'Check them in'}</button>
          <button type="button" className="link" onClick={() => { setAdding(false); setError(''); setNeedName(false); }}>Cancel</button>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

// ---------- Who has signed up ----------
const PAY_LABEL = { none: 'Not paid', claimed: 'Says paid', confirmed: 'Paid', venue: 'Pay at venue' };
const payState = (p) => (p.status === 'confirmed' && (p.payment || 'none') !== 'confirmed' ? 'confirmed' : (p.payment || 'none'));

function Signups({ run, onChange }) {
  const list = run.signups || [];
  const fields = run.signup_fields || [];
  const paid = run.price > 0;
  const online = run.payment_mode === 'online';
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  async function setPay(memberId, status) {
    setBusy(memberId); setError('');
    try { onChange(await adminSetPayment(run.id, memberId, status)); } catch (e) { setError(messageFor(e.code)); } finally { setBusy(''); }
  }
  const fileFields = fields.filter((f) => f.type === 'file');
  const filePaths = fileFields.length ? list.flatMap((p) => fileFields.map((f) => p.answers?.[f.id])).filter(Boolean) : [];
  const fileKey = filePaths.join('|');
  const [urls, setUrls] = useState({});
  useEffect(() => {
    if (!fileKey) return;
    signedFileUrls(fileKey.split('|')).then(setUrls).catch(() => setUrls({}));
  }, [fileKey]);
  const counts = paid ? list.reduce((c, p) => ({ ...c, [payState(p)]: (c[payState(p)] || 0) + 1 }), {}) : {};
  const confirmedN = list.filter((p) => p.status === 'confirmed').length;
  const pendingN = list.length - confirmedN;

  async function downloadCsv() {
    let links = {};
    try { links = filePaths.length ? await signedFileUrls(filePaths, 7 * 24 * 3600) : {}; } catch { /* leave file cells as a note */ }
    const cell = (f, v) => (f.type === 'file' ? (v ? links[v] || 'uploaded (open in the app)' : '') : answerText(v));
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const ran = Object.fromEntries((run.attendees || []).map((a) => [a.phone, a.km]));
    const checked = new Set((run.attendees || []).map((a) => a.phone));
    const classesOf = (phone) => (run.attendees || []).filter((a) => a.phone === phone).length;
    const head = ['Name', 'Number', 'Signed up at', run.kind === 'program' ? 'Classes attended' : run.kind === 'event' ? 'Checked in' : 'Checked in (km)', ...(paid ? ['Payment'] : []), ...fields.map((f) => f.label)];
    const rows = list.map((p) => [p.name, p.phone, new Date(p.at).toLocaleString('en-IN'),
      run.kind === 'program' ? `${classesOf(p.phone)}/${run.classes || ''}` : run.kind === 'event' ? (checked.has(p.phone) ? 'Yes' : '') : (ran[p.phone] ?? ''),
      ...(paid ? [p.status === 'pending' ? `Pending (${PAY_LABEL[payState(p)]})` : PAY_LABEL[payState(p)]] : []), ...fields.map((f) => cell(f, p.answers?.[f.id]))]);
    const csv = [head, ...rows].map((r) => r.map(esc).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = `signups-${run.date}-${run.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`;
    a.click();
  }

  return (
    <section className="signups" aria-labelledby="su-title">
      <h2 className="section-title" id="su-title">
        Signed up · {confirmedN}{run.capacity != null ? ` of ${run.capacity}` : ''}{pendingN ? ` · ${pendingN} pending` : ''}
      </h2>
      {paid && online && list.length > 0 && (
        <p className="hint">{rupees(run.price)} each · {list.filter((p) => p.status === 'confirmed').length} paid{run.pay_at_venue ? ` · ${list.filter((p) => p.payment === 'venue').length} paying at the venue` : ''}. Spots are booked only once paid{run.pay_at_venue ? ' or marked pay-at-venue' : ''}.</p>
      )}
      {paid && !online && list.length > 0 && (
        <p className="hint">{rupees(run.price)} each · {counts.confirmed || 0} paid · {counts.claimed || 0} say paid, check and confirm · {counts.none || 0} not paid yet. Pending people hold a spot until you confirm or remove them.</p>
      )}
      {list.length === 0 ? (
        <p className="muted">{run.signup_enabled ? 'No sign-ups yet.' : 'Sign-ups are closed.'}</p>
      ) : (
        <>
          <ol className="su-list">
            {list.map((p, i) => (
              <li key={`${p.phone}-${i}`}>
                <div className="su-row"><span>{p.name}{p.test && <span className="pill-mini test-pill">Test</span>}</span><span className="muted">{p.phone}</span></div>
                {paid && (
                  <div className="pay-row">
                    <span className={`pay-chip pay-${p.status === 'pending' && p.holds === false ? 'cancelled' : payState(p)}`}>
                      {p.payment_ref ? `Paid online · ${rupees(p.amount || run.price)}`
                        : p.payment === 'venue' ? `Pay at venue · ${rupees(run.price)} due`
                        : p.status === 'pending' ? `Pending · ${PAY_LABEL[payState(p)].toLowerCase()}`
                        : PAY_LABEL[payState(p)]}
                    </span>
                    {p.status === 'pending' ? (
                      <>
                        <button className="link inline" disabled={busy === p.member_id} onClick={() => setPay(p.member_id, 'confirmed')}>Mark paid</button>
                        <button className="link inline" disabled={busy === p.member_id} onClick={() => setPay(p.member_id, 'remove')}>Remove</button>
                      </>
                    ) : (
                      <button className="link inline" disabled={busy === p.member_id} onClick={() => setPay(p.member_id, 'none')}>Undo</button>
                    )}
                  </div>
                )}
                {fields.some((f) => answerText(p.answers?.[f.id], f)) && (
                  <div className="su-answers">
                    {fields.filter((f) => answerText(p.answers?.[f.id], f)).map((f) => (
                      <span key={f.id}><span className="muted">{f.label}:</span>{' '}
                        {f.type === 'file'
                          ? (urls[p.answers[f.id]]
                            ? <a className="link inline file-link" href={urls[p.answers[f.id]]} target="_blank" rel="noreferrer">{/\.pdf$/i.test(p.answers[f.id]) ? 'Open PDF' : 'View photo'}</a>
                            : <span className="muted">loading…</span>)
                          : answerText(p.answers[f.id])}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ol>
          <button className="btn ghost" onClick={downloadCsv}>Download list (CSV)</button>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
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
      <p className="muted">Print this and keep it at the venue. People scan it in the app to check in. {run.kind === 'program' ? 'Use the same QR at every class: it works from the first class until you end the program, once per person per day.' : 'It only works on the day, and only for this one.'}</p>
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

// ---------- Scan tickets at the door ----------
export function AdminScan({ eventId, code }) {
  const [phase, setPhase] = useState(code ? 'busy' : 'scan'); // scan | busy | result | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [typed, setTyped] = useState('');
  const [count, setCount] = useState(0);
  const [busyPay, setBusyPay] = useState(false);
  const [camErr, setCamErr] = useState('');

  const lookup = useCallback(async (raw) => {
    const s = readScan(raw);
    if (s.kind !== 'ticket') { setError(messageFor('ticket_not_found')); setPhase('error'); return; }
    setPhase('busy'); setError('');
    try {
      const r = await adminScanTicket(s.code, eventId || null);
      setResult(r);
      if (r.ok && !r.already) setCount((c) => c + 1);
      setPhase('result');
    } catch (e) { setError(messageFor(e.code)); setPhase('error'); }
  }, [eventId]);

  useEffect(() => { if (code) lookup(code); }, [code, lookup]);

  async function markPaid() {
    setBusyPay(true);
    try { await adminSetPayment(result.event_id, result.member_id, 'confirmed'); setResult((r) => ({ ...r, payment: 'confirmed', status: 'confirmed', due: 0 })); }
    catch (e) { setError(messageFor(e.code)); }
    finally { setBusyPay(false); }
  }
  const back = eventId ? href(`admin/run/${eventId}`) : href('admin');
  const ok = result?.ok;

  return (
    <main className="shell scan-shell">
      <header className="topbar">
        <a className="link back" href={back}>‹ Back</a>
        <span className="admin-tag">{count} checked in</span>
      </header>
      <h1 className="display">Scan tickets</h1>
      {phase === 'scan' && (
        <>
          <p className="lede">Point the camera at a ticket QR.</p>
          {camErr
            ? <p className="note">{camErr} You can still type the code from the ticket.</p>
            : <Suspense fallback={<div className="scanner" />}><Scanner onResult={lookup} onError={(c) => setCamErr(messageFor(c))} /></Suspense>}
          <form className="row code-row" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) lookup(typed.trim()); }}>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value.toUpperCase())} placeholder="or type the code, e.g. MT-ABC123" aria-label="Ticket code" autoCapitalize="characters" autoCorrect="off" />
            <button className="btn small-btn" type="submit" disabled={!typed.trim()}>Go</button>
          </form>
        </>
      )}
      {phase === 'busy' && <p className="status">Checking…</p>}
      {phase === 'result' && result && (
        <div className={`scan-result ${ok ? (result.already ? 'again' : 'ok') : 'bad'}`} role="status">
          <p className="scan-big">{ok ? (result.already ? 'Already in' : 'Checked in') : messageFor(result.error)}</p>
          <p className="scan-name">{result.name}{result.test && <span className="pill-mini test-pill">Test</span>}</p>
          <p className="muted">{result.event}{result.phone ? ` · ${result.phone}` : ''}</p>
          {ok && result.kind === 'program' && result.classes && <p className="muted">Class {Math.min(result.done, result.classes)} of {result.classes}{result.badge ? ' · badge earned' : ''}</p>}
          {ok && result.kind === 'run' && result.km != null && <p className="muted">Logged {Number(result.km)} km</p>}
          {ok && result.due > 0 && (
            <div className="scan-due">
              <p className="pending-banner">Collect {rupees(result.due)}{result.payment === 'venue' ? ' · pay at venue' : ''}</p>
              <button className="btn" onClick={markPaid} disabled={busyPay}>{busyPay ? 'Saving…' : 'Mark paid'}</button>
            </div>
          )}
          {ok && result.due === 0 && result.payment === 'confirmed' && <p className="signed-banner"><span aria-hidden="true">✓</span> Paid</p>}
          {!ok && result.error === 'wrong_event' && result.event_id && (
            <a className="link inline" href={href(`admin/scan?e=${result.event_id}`)}>Switch to {result.event}</a>
          )}
          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn" onClick={() => { setResult(null); setError(''); setPhase('scan'); }}>Scan next</button>
        </div>
      )}
      {phase === 'error' && (
        <div className="stack scan-error">
          <p className="error" role="alert">{error}</p>
          <button className="btn" onClick={() => { setError(''); setPhase('scan'); }}>Scan again</button>
        </div>
      )}
    </main>
  );
}
