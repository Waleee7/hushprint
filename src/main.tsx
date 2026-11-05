import '@fontsource/barlow-condensed/latin-600.css';
import '@fontsource/barlow-condensed/latin-800.css';
import '@fontsource/barlow-semi-condensed/latin-400.css';
import '@fontsource/barlow-semi-condensed/latin-600.css';
import '@fontsource/permanent-marker/latin-400.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

// Offline support. The worker caches the app shell only; it cannot read your files.
// Trusted Types: the one policy this app creates can only ever produce the URL of its own worker script.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const tt = (window as unknown as { trustedTypes?: { createPolicy(n: string, o: { createScriptURL(u: string): string }): { createScriptURL(u: string): string } } }).trustedTypes;
  const policy = tt?.createPolicy('hushprint-sw', {
    createScriptURL: (url: string) => { if (url !== '/sw.js') throw new TypeError('only /sw.js may be registered'); return url; },
  });
  window.addEventListener('load', () => {
    const url = policy ? policy.createScriptURL('/sw.js') : '/sw.js';
    navigator.serviceWorker.register(url as unknown as string).catch(() => undefined);
  });
}
