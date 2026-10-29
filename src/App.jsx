import { useEffect, useState } from 'react';
import { supabase } from './api.js';
import Login from './Login.jsx';
import Home from './Home.jsx';
import Wordmark from './Wordmark.jsx';

export default function App() {
  // undefined = still checking for a saved login
  const [session, setSession] = useState(undefined);

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
  return session ? <Home key={session.user.id} /> : <Login />;
}
