import { useEffect, useState } from 'react';

// Tiny hash router: #/run/<id>, #/admin, ... Works on any static host with no server config,
// and lets a venue QR open the app straight on the check-in screen.
function parse(hash) {
  const s = hash.replace(/^#\/?/, '');
  const [path, query = ''] = s.split('?');
  return { parts: path.split('/').filter(Boolean), query: new URLSearchParams(query) };
}

export function useRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => {
      setHash(window.location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return parse(hash);
}

export const go = (path) => {
  window.location.hash = `#/${String(path).replace(/^[#/]+/, '')}`;
};

export const href = (path) => `#/${String(path).replace(/^[#/]+/, '')}`;
