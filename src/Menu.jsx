import { useEffect, useRef, useState } from 'react';
import { logOut } from './api.js';
import { href, useRoute } from './router.js';
import Wordmark from './Wordmark.jsx';
import Avatar from './Avatar.jsx';

// Hamburger button + side panel with every main section of the app.
export default function Menu({ profile }) {
  const [open, setOpen] = useState(false);
  const { parts } = useRoute();
  const btn = useRef(null);
  const panel = useRef(null);
  const here = parts[0] || '';

  useEffect(() => { setOpen(false); }, [parts.join('/')]); // close after navigating
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    panel.current?.querySelector('a, button')?.focus();
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; btn.current?.focus(); };
  }, [open]);

  const items = [
    { to: '', label: 'Home', on: here === '' },
    { to: 'events', label: 'Events', sub: 'Coming up and past', on: here === 'events' || here === 'run' },
    { to: 'leaderboard', label: 'Run Leaderboard', sub: 'Km, ranks and milestones', on: here === 'leaderboard' },
    ...(profile ? [{ to: 'me', label: 'My runs & badges', sub: 'Your km, badges and events', on: here === 'me' }] : []),
    ...(profile?.is_admin ? [{ to: 'admin', label: 'Admin', sub: 'Events, members, badges', on: here === 'admin' }] : []),
  ];

  return (
    <>
      <button ref={btn} type="button" className="menu-btn" aria-label="Open menu" aria-expanded={open} aria-controls="app-menu" onClick={() => setOpen(true)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
      </button>
      {open && <div className="menu-scrim" onClick={() => setOpen(false)} aria-hidden="true" />}
      <nav id="app-menu" ref={panel} className={`menu-panel${open ? ' open' : ''}`} aria-label="Main menu" aria-hidden={!open} inert={open ? undefined : ''}>
        <div className="menu-top">
          <Wordmark small />
          <button type="button" className="menu-close" aria-label="Close menu" onClick={() => setOpen(false)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        {profile && (
          <a className="menu-who" href={href('me')}>
            <Avatar name={profile.name} url={profile.avatar_url} size={44} />
            <span><strong>{profile.name}</strong><small>View your profile</small></span>
          </a>
        )}
        <ul className="menu-list">
          {items.map((it) => (
            <li key={it.to || 'home'}>
              <a href={href(it.to)} className={it.on ? 'on' : ''} aria-current={it.on ? 'page' : undefined}>
                <span>{it.label}</span>
                {it.sub && <small>{it.sub}</small>}
              </a>
            </li>
          ))}
        </ul>
        <div className="menu-foot">
          {profile
            ? <button type="button" className="btn ghost" onClick={logOut}>Log out</button>
            : <a className="btn" href={href('login')}>Log in</a>}
        </div>
      </nav>
    </>
  );
}
