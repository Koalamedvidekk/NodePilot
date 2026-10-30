const RECOVERY_KEY = 'nodepilot:update-recovery';

declare global {
  interface Window {
    nodePilotUpdateRecovery?: { begin(expectedVersion: string): void };
  }
}

/** Keep an update progress screen alive while the local backend restarts. */
export function beginUpdateRecovery(expectedVersion: string): void {
  if (!expectedVersion || expectedVersion.length > 64) return;
  try {
    sessionStorage.setItem(RECOVERY_KEY, JSON.stringify({ expectedVersion, startedAt: Date.now(), sawOffline: false }));
  } catch {
    // The current document still monitors the restart when storage is disabled.
  }
  if (window.nodePilotUpdateRecovery) {
    window.nodePilotUpdateRecovery.begin(expectedVersion);
    return;
  }

  // Old cached HTML may not have loaded the dependency-free bootstrap script.
  const fallback = document.createElement('div');
  fallback.id = 'nodepilot-bootstrap';
  fallback.setAttribute('role', 'status');
  fallback.style.cssText = 'position:fixed;inset:0;z-index:10000;display:grid;place-content:center;padding:28px;background:#070a12;color:#edf2ff;font:16px system-ui;line-height:1.6';
  fallback.textContent = 'NodePilot is applying the update. Keep this tab open. If it does not return, run start.bat on Windows or start.sh on Linux, then reload this page.';
  document.getElementById(fallback.id)?.remove();
  document.body.append(fallback);
  const script = document.createElement('script');
  script.src = '/update-recovery.js';
  script.onload = () => window.nodePilotUpdateRecovery?.begin(expectedVersion);
  document.head.append(script);
}
