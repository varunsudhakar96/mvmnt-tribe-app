import Wordmark from './Wordmark.jsx';
import Avatar from './Avatar.jsx';
import { UpcomingRuns, PastEvents } from './Runs.jsx';
import { href } from './router.js';

// The main page for everyone: the quote, the runs, and Log in (or your photo once logged in).
export default function Landing({ profile }) {
  return (
    <main className="shell">
      <header className="topbar">
        <Wordmark small />
        {profile === undefined ? <span className="avatar-btn" aria-hidden="true" /> : profile ? (
          <a className="avatar-btn" href={href('me')} aria-label="Your runs and badges">
            <Avatar name={profile.name} url={profile.avatar_url} size={40} />
          </a>
        ) : (
          <a className="btn small-btn" href={href('login')}>Log in</a>
        )}
      </header>

      <section className="hero" aria-label="Mvmnt Tribe">
        <h1 className="hero-quote">Let's get<br />stronger<br />together.</h1>
        <p className="lede">Weekend runs, events and programs in Coimbatore. Sign up, show up, scan in.</p>
      </section>

      <UpcomingRuns />
      <PastEvents />
    </main>
  );
}
