import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './base.css';
import './app.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// What a load shows while the server is down, instead of the browser's own error page (web/public/sw.js). Only on
// the built app the server serves: the dev server's reloads are its own business.
if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
