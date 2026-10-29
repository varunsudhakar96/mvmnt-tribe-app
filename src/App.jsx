import { useEffect, useState } from 'react';
import { supabase } from './api.js';
import { useRoute } from './router.js';
import Login from './Login.jsx';
import Home from './Home.jsx';
import Wordmark from './Wordmark.jsx';
import { RunPage } from './Runs.jsx';
import Landing from './Landing.jsx';

export default function App() {
  // undefined = still checking for a saved login
  const [session, setSession] = useState(undefined);
  const { parts, query } = useRoute();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s ?? null));
    return () => data.subscription.unsubscribe();
  }, []);

  if (session === undefined) {
    return (
      <main className="shell center" aria-busy="true">
        <Wordmark />
      </main>
    );
  }
  if (session) return <Home key={session.user.id} />;

  // Logged out: a run page can be viewed by anyone with the link.
  const [a, b, c] = parts;
  if (!a) return <Landing profile={null} />;
  if (a === 'run' && b && !c) return <RunPage id={b} profile={null} />;

  // Everything else needs a login. After logging in, Home picks up where they were going.
  const next = a === 'login' ? query.get('next') || '' : parts.join('/');
  const runId = next.match(/^run\/([0-9a-f-]{36})/)?.[1];
  return <Login backHref={runId ? `#/run/${runId}` : '#/'}
                note={/\/signup$/.test(next) ? 'Log in to sign up for this run.' : /\/(scan|checkin)/.test(next) ? 'Log in to check in.' : null} />;
}
