import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './shell/App.js';
import { useShellData } from './shell/useShellData.js';

function ShellRoot() {
  const { snapshot, logs, control, loadOlder } = useShellData();
  if (snapshot === null) return <main>正在载入多元宇宙…</main>;
  return <App snapshot={snapshot} logs={logs} onControl={control} onLoadOlder={loadOlder} />;
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<StrictMode><ShellRoot /></StrictMode>);
