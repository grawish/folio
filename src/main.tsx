import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initializeAppearance } from './appearance';
import { initializePreferences } from './preferences';
import './styles.css';
import './chat.css';

function Startup() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const start = async () => {
    setError('');
    try {
      await initializePreferences();
      initializeAppearance();
      setReady(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  useEffect(() => {
    void start();
  }, []);
  useEffect(() => {
    if (ready) return;
    return window.folio?.onMenu((action) => {
      if (action === 'close')
        void window.folio?.closeWindow().catch((error) => setError(error.message));
    });
  }, [ready]);
  if (ready)
    return (
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  return (
    <div className="startup-screen" role={error ? 'alert' : 'status'}>
      <h1>{error ? 'Your settings could not be opened' : 'Opening your settings'}</h1>
      {error && (
        <>
          <p>{error}</p>
          <p>Your saved settings and project files have been kept.</p>
          <button
            className="button primary"
            onClick={() => {
              void start();
            }}
          >
            Try again
          </button>
        </>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Startup />);
