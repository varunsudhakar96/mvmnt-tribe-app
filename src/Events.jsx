import { UpcomingRuns, PastEvents } from './Runs.jsx';
import Menu from './Menu.jsx';
import Wordmark from './Wordmark.jsx';
import { href } from './router.js';

// All events in one place: what's coming up, then what's finished.
export default function Events({ profile }) {
  return (
    <main className="shell">
      <header className="topbar">
        <span className="top-left"><Menu profile={profile} /><a href={href('')} aria-label="Home"><Wordmark small /></a></span>
      </header>
      <h1 className="display page-title">Events</h1>
      <UpcomingRuns />
      <PastEvents showAll />
    </main>
  );
}
