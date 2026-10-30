// This recovery UI deliberately has no React or hashed-asset dependencies.
(() => {
  'use strict';
  const key = 'nodepilot:update-recovery';
  const timeoutMs = 180000;
  const pollMs = 2000;
  let marker = null;
  let timer;
  let deadline;
  let busy = false;
  let finished = false;
  let bootstrapTimer;
  const root = document.getElementById('root');
  let panel = document.getElementById('nodepilot-bootstrap');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'nodepilot-bootstrap';
    document.body.append(panel);
  }
  panel.style.cssText = 'position:fixed;inset:0;z-index:10000;display:grid;place-content:center;padding:28px;background:#070a12;color:#edf2ff;font:16px system-ui;line-height:1.6';
  panel.setAttribute('role', 'status');
  panel.setAttribute('aria-live', 'polite');

  function persist() {
    try { sessionStorage.setItem(key, JSON.stringify(marker)); } catch (_) {}
  }

  function clear() {
    try { sessionStorage.removeItem(key); } catch (_) {}
    marker = null;
  }

  function stop() {
    finished = true;
    clearTimeout(timer);
    clearTimeout(deadline);
  }

  function reloadFresh() {
    clear();
    const url = new URL(window.location.href);
    url.searchParams.set('_nodepilot_reload', String(Date.now()));
    window.location.replace(url.href);
  }

  function render(title, message, options = {}) {
    panel.hidden = false;
    panel.style.display = 'grid';
    panel.replaceChildren();
    const card = document.createElement('section');
    card.style.cssText = 'max-width:620px;padding:30px;border:1px solid #33415b;border-radius:16px;background:#101827';
    const heading = document.createElement('h1');
    heading.textContent = title;
    heading.style.cssText = 'margin:0 0 12px;font-size:24px';
    const copy = document.createElement('p');
    copy.textContent = message;
    copy.style.margin = '0 0 16px';
    card.append(heading, copy);
    if (options.manual) {
      const help = document.createElement('p');
      help.textContent = 'On the computer running NodePilot, run start.bat on Windows or ./start.sh on Linux. Keep your .nodepilot folder and .env file. Then choose Check again below.';
      help.style.color = '#b7c4da';
      card.append(help);
    }
    if (options.retry) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = marker ? 'Check again' : 'Retry loading panel';
      retry.style.cssText = 'cursor:pointer;padding:10px 16px;border:1px solid #9b8eff;border-radius:8px;background:#7962dd;color:white;font:inherit;margin:6px 12px 0 0';
      retry.addEventListener('click', () => {
        if (marker) start({ ...marker, startedAt: Date.now() });
        else reloadFresh();
      });
      card.append(retry);
    }
    if (options.openPanel) {
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = options.openPanel;
      open.style.cssText = 'cursor:pointer;padding:10px 16px;border:1px solid #59677e;border-radius:8px;background:transparent;color:white;font:inherit;margin-top:6px';
      open.addEventListener('click', reloadFresh);
      card.append(open);
    }
    panel.append(card);
  }

  function fail(title, message, openPanel) {
    stop();
    render(title, message, { manual: true, retry: true, openPanel });
  }

  async function poll() {
    if (finished || busy || !marker) return;
    busy = true;
    const controller = new AbortController();
    const requestTimeout = setTimeout(() => controller.abort(), 5000);
    try {
      let pin;
      try { pin = localStorage.getItem('nodepilot_pin'); } catch (_) {}
      const response = await fetch('/api/host/updates', {
        cache: 'no-store',
        signal: controller.signal,
        headers: { Accept: 'application/json', ...(pin ? { 'x-nodepilot-pin': pin } : {}) },
      });
      if (finished) return;
      if (response.status === 401) {
        fail('NodePilot needs your access PIN', 'The panel is responding again. Open it to unlock with your existing PIN, then check the update version.', 'Open panel to unlock');
        return;
      }
      if (!response.ok) throw new Error('The local panel is not ready.');
      const payload = await response.json();
      const update = payload.update ?? payload.data?.update;
      if (finished || !update || typeof update.currentVersion !== 'string') return;
      if (update.currentVersion.replace(/^v/, '') === marker.expectedVersion.replace(/^v/, '')) {
        stop();
        render('Update complete', 'NodePilot v' + marker.expectedVersion + ' is ready. Reopening the panel…');
        clear();
        setTimeout(reloadFresh, 250);
        return;
      }
      if (update.status === 'error') {
        fail('NodePilot update did not finish', update.error || update.statusMessage || 'The previous version is still running.', 'Open available panel');
        return;
      }
      if (marker.sawOffline && !['ready_to_restart', 'restarting', 'installing', 'backing_up'].includes(update.status)) {
        fail('NodePilot returned to the previous version', 'The panel is running v' + update.currentVersion + ', but v' + marker.expectedVersion + ' was requested. The update may have been rolled back. You can reopen the available panel.', 'Open previous version');
        return;
      }
      render('Updating NodePilot', update.statusMessage || 'Waiting for NodePilot v' + marker.expectedVersion + ' to finish installing and restart. Keep this tab open.');
    } catch (_) {
      if (finished || !marker) return;
      marker.sawOffline = true;
      persist();
      render('NodePilot is restarting', 'The local panel is temporarily unavailable while the update is applied. This tab will reconnect when v' + marker.expectedVersion + ' is ready.');
    } finally {
      clearTimeout(requestTimeout);
      busy = false;
      if (!finished) timer = setTimeout(poll, pollMs);
    }
  }

  function start(value) {
    stop();
    finished = false;
    marker = value;
    persist();
    clearTimeout(bootstrapTimer);
    const remaining = Math.min(timeoutMs, timeoutMs - (Date.now() - marker.startedAt));
    if (remaining <= 0) {
      fail('NodePilot has not returned yet', 'The update has taken longer than three minutes. This page has stopped waiting automatically so you can recover the panel.');
      return;
    }
    render('Updating NodePilot', 'Installing v' + marker.expectedVersion + ' and waiting for the local panel to restart. Keep this tab open.');
    deadline = setTimeout(() => fail('NodePilot has not returned yet', 'The update has taken longer than three minutes. This page has stopped waiting automatically so you can recover the panel.'), remaining);
    void poll();
  }

  window.nodePilotUpdateRecovery = {
    begin(expectedVersion) {
      if (typeof expectedVersion !== 'string' || !expectedVersion || expectedVersion.length > 64) return;
      start({ expectedVersion, startedAt: Date.now(), sawOffline: false });
    },
  };

  try {
    const stored = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (stored && typeof stored.expectedVersion === 'string' && stored.expectedVersion.length > 0 && stored.expectedVersion.length <= 64 && Number.isFinite(stored.startedAt)) marker = stored;
  } catch (_) {}

  if (marker) start(marker);
  else {
    const checkMounted = () => {
      if (!marker && root?.hasChildNodes()) {
        panel.hidden = true;
        panel.style.display = 'none';
        clearTimeout(bootstrapTimer);
      }
    };
    if (root) new MutationObserver(checkMounted).observe(root, { childList: true });
    checkMounted();
    bootstrapTimer = setTimeout(() => {
      if (!marker && !root?.hasChildNodes()) render('The NodePilot panel could not load', 'The browser could not load the application files. This can happen after an update replaces cached assets. Retry once the local NodePilot process is running.', { manual: true, retry: true });
    }, 8000);
    window.addEventListener('error', (event) => {
      if (!marker && event.target instanceof HTMLScriptElement && event.target.type === 'module') {
        clearTimeout(bootstrapTimer);
        render('The NodePilot panel could not load', 'An application file could not be loaded. Retry to request the current panel files from NodePilot.', { manual: true, retry: true });
      }
    }, true);
  }
})();
