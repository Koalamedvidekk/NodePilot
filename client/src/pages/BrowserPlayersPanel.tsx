import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "../api";
import {
  browserAccessApi,
  type BrowserAccessStatus,
} from "../browser-access-api";
import { Icon } from "../components/Icon";
import type { Server } from "../types";
import { errorMessage, titleCase } from "../utils";
import "./browser-players.css";

function browserError(cause: unknown): string {
  if (
    cause instanceof ApiError &&
    cause.status === 404 &&
    typeof cause.details === "object" &&
    cause.details !== null &&
    "error" in cause.details &&
    cause.details.error === "not_found"
  ) {
    return "The running backend does not have Browser Players yet. Restart NodePilot after updating the backend and browser app together.";
  }
  return errorMessage(cause);
}

export function BrowserPlayersPanel({ server }: { server: Server }) {
  const [status, setStatus] = useState<BrowserAccessStatus>();
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<string>();
  const [error, setError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [approved, setApproved] = useState(false);
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const next = await browserAccessApi.status(server.id);
      if (request !== sequence.current) return;
      setStatus(next);
      setLoadError(undefined);
    } catch (cause) {
      if (request === sequence.current) setLoadError(browserError(cause));
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [server.id]);

  useEffect(() => {
    void load();
    return () => {
      sequence.current += 1;
    };
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(
      () => void load(),
      status?.status === "preparing" || status?.status === "starting"
        ? 1_500
        : 5_000,
    );
    return () => window.clearInterval(timer);
  }, [load, status?.status]);

  useEffect(() => {
    setApproved(false);
  }, [status?.preview?.revision]);

  const busy =
    Boolean(action) ||
    status?.status === "preparing" ||
    status?.status === "starting";
  const stopped = server.status === "stopped" || server.status === "error";
  const available = status?.capabilities.available === true;
  const canChange =
    stopped && available && !busy && server.directoryExists !== false;
  const shownError = error ?? status?.error ?? loadError;

  const run = async (
    label: string,
    operation: () => Promise<unknown>,
    message?: string,
  ) => {
    setAction(label);
    setError(undefined);
    setNotice(undefined);
    sequence.current += 1;
    try {
      await operation();
      if (message) setNotice(message);
    } catch (cause) {
      setError(browserError(cause));
    } finally {
      await load();
      setAction(undefined);
    }
  };

  const disable = async () => {
    if (
      !window.confirm(
        "Disable browser access?\n\nNodePilot will stop its gateway and temporary tunnel, and restore the server configuration it changed. The server must be stopped.",
      )
    )
      return;
    await run(
      "disable",
      () => browserAccessApi.disable(server.id),
      "Browser access disabled.",
    );
  };

  const copyAddress = async () => {
    if (!status?.publicAddress) return;
    try {
      await navigator.clipboard.writeText(status.publicAddress);
      setNotice(
        "Browser server address copied. Paste it into Eaglercraft’s multiplayer screen.",
      );
    } catch {
      setError(
        "The browser could not copy the address. Select and copy the address shown here.",
      );
    }
  };

  if (loading && !status)
    return (
      <section className="panel management-panel">
        <div className="management-loading">
          <span className="button-loader" /> Reading browser access status…
        </div>
      </section>
    );

  return (
    <section className="browser-players-panel">
      <div className="versions-heading">
        <div>
          <h3>Browser Players</h3>
          <p>
            Connect Eaglercraft players to this server through an EaglerX WSS gateway.
          </p>
        </div>
        <button
          className="button button-secondary"
          type="button"
          onClick={() => void load()}
          disabled={busy}
        >
          <Icon name="refresh" size={16} /> Refresh status
        </button>
      </div>

      {shownError && (
        <div className="inline-alert alert-error" role="alert">
          <Icon name="warning" size={19} />
          <div>
            <strong>Browser access needs attention.</strong>
            <span>{shownError}</span>
          </div>
          {error && (
            <button
              className="text-button"
              type="button"
              onClick={() => setError(undefined)}
            >
              Dismiss
            </button>
          )}
        </div>
      )}
      {notice && (
        <div className="inline-alert alert-success" role="status">
          <Icon name="check" size={17} />
          <div>{notice}</div>
        </div>
      )}

      {status && (
        <>
          {!available && (
            <div className="inline-alert alert-info">
              <Icon name="info" size={19} />
              <div>
                <strong>Browser access is unavailable.</strong>
                {status.capabilities.reasons.map((reason) => (
                  <span key={reason}>{reason}</span>
                ))}
              </div>
            </div>
          )}
          {available && !status.capabilities.verified && (
            <div className="inline-alert alert-info">
              <Icon name="info" size={19} />
              <div>
                <strong>Experimental browser compatibility</strong>
                <span>
                  This server and client combination has not passed a playable
                  connection check. The setup is available for testing.
                </span>
              </div>
            </div>
          )}

          <section className="panel management-panel">
            <div className="panel-heading">
              <div>
                <h3>Browser gateway</h3>
                <p>
                  {status.phase ??
                    (status.enabled
                      ? "Gateway enabled for this server."
                      : "Set up the gateway while Minecraft is stopped.")}
                </p>
              </div>
              <span
                className={`status-pill ${status.status === "running" ? "is-online" : status.status === "error" || status.status === "recovery_required" ? "is-warning" : "is-offline"}`}
              >
                {titleCase(status.status.replaceAll("_", " "))}
              </span>
            </div>
            {status.progressPercent !== null && (
              <div className="browser-operation" role="status">
                <progress
                  max={100}
                  value={status.progressPercent}
                  aria-label="Browser setup progress"
                />
                <span>
                  {status.phase ?? "Preparing browser access"} ·{" "}
                  {Math.round(status.progressPercent)}%
                </span>
              </div>
            )}
            {status.publicAddress && (
              <div className="browser-address">
                <label htmlFor="browser-public-address">
                  Eaglercraft server address
                </label>
                <div>
                  <input
                    id="browser-public-address"
                    readOnly
                    value={status.publicAddress}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <button
                    className="button button-primary"
                    type="button"
                    onClick={() => void copyAddress()}
                  >
                    <Icon name="copy" size={16} /> Copy Address
                  </button>
                </div>
                <p>
                  In Eaglercraft, open Multiplayer, paste this address, and join with your player name.
                </p>
              </div>
            )}
            <div className="browser-gateway-actions">
              {!status.configured && (
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={!canChange}
                  onClick={() =>
                    void run("inspect", () =>
                      browserAccessApi.inspect(server.id),
                    )
                  }
                >
                  <Icon name="download" size={16} />{" "}
                  {action === "inspect" || status.status === "preparing"
                    ? "Preparing Setup…"
                    : "Set Up"}
                </button>
              )}
              {status.configured &&
                (!status.enabled || status.status === "error") && (
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={!canChange}
                    onClick={() =>
                      void run("enable", () =>
                        browserAccessApi.enable(server.id),
                      )
                    }
                  >
                    <Icon name="play" size={16} />{" "}
                    {action === "enable" || status.status === "starting"
                      ? "Starting Gateway…"
                      : status.status === "error"
                        ? "Retry Gateway"
                        : status.needsOpenEnable ? "Enable public access" : "Enable"}
                  </button>
                )}
              {status.configured && (
                <button
                  className="button button-danger-outline"
                  type="button"
                  disabled={!stopped || busy}
                  onClick={() => void disable()}
                >
                  <Icon name="square" size={16} />{" "}
                  {action === "disable" ? "Disabling…" : "Disable"}
                </button>
              )}
            </div>
            {!stopped && (
              <p className="input-note">
                Stop Minecraft before setting up, enabling, or disabling browser
                access.
              </p>
            )}
            <div className="browser-notes">
              <p>Players join directly. If you want to verify player names, install a compatible login plugin on your Minecraft server.</p>
              <p>
                Cloudflare provides a temporary public WSS address without an
                account or port forwarding. The address changes when the tunnel
                restarts. Quick Tunnels are a testing service with no uptime
                guarantee.
              </p>
              <p>
                Target browser clients
                {status.capabilities.targetClients.length
                  ? ` · ${status.capabilities.targetClients.join(", ")}`
                  : " are unavailable for this configuration"}
                . Older clients can show translated blocks and features.
              </p>
              {status.capabilities.backendVersion && <p>Minecraft server version · {status.capabilities.backendVersion}</p>}
              {status.capabilities.notes?.map(note => <p key={note}>{note}</p>)}
            </div>
            {Object.keys(status.versions).length > 0 && (
              <details className="browser-details">
                <summary>Installed gateway components</summary>
                <dl>
                  {Object.entries(status.versions).map(
                    ([component, version]) => (
                      <div key={component}>
                        <dt>{component}</dt>
                        <dd>{version}</dd>
                      </div>
                    ),
                  )}
                </dl>
              </details>
            )}
          </section>

          {status.preview && (
            <section
              className="panel management-panel browser-preview"
              aria-labelledby="browser-preview-heading"
            >
              <div className="panel-heading">
                <div>
                  <h3 id="browser-preview-heading">
                    Server configuration changes
                  </h3>
                  <p>
                    NodePilot will back up the affected configuration before
                    applying these changes.
                  </p>
                </div>
              </div>
              <ul>
                {status.preview.changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
              {status.preview.warnings.map((warning) => (
                <p className="input-note" key={warning}>
                  <Icon name="warning" size={15} /> {warning}
                </p>
              ))}
              <label className="browser-approval">
                <input
                  type="checkbox"
                  checked={approved}
                  onChange={(event) => setApproved(event.target.checked)}
                  disabled={busy || !stopped}
                />
                <span>
                  I approve the changes to the server and gateway configuration shown above.
                </span>
              </label>
              <button
                className="button button-primary"
                type="button"
                disabled={!canChange || !approved}
                onClick={() =>
                  void run(
                    "setup",
                    () =>
                      browserAccessApi.setup(
                        server.id,
                        status.preview!.revision,
                      ),
                    "Gateway configuration applied. Enable browser access to create a public address.",
                  )
                }
              >
                <Icon name="check" size={16} />{" "}
                {action === "setup"
                  ? "Applying Setup…"
                  : "Approve & Apply Setup"}
              </button>
            </section>
          )}

          <section className="panel management-panel">
            <div className="panel-heading">
              <div>
                <h3>Gateway logs</h3>
                <p>
                  Live status from NodePilot’s gateway and tunnel processes.
                </p>
              </div>
            </div>
            <div
              className="terminal-window browser-logs"
              aria-label="Browser gateway logs"
            >
              {status.logs.length ? (
                status.logs.map((line, index) => (
                  <div
                    className="console-line"
                    key={`${line.timestamp}-${index}`}
                  >
                    <span className="console-time">
                      {new Date(line.timestamp).toLocaleTimeString()}
                    </span>
                    <span className="console-message">{line.message}</span>
                  </div>
                ))
              ) : (
                <p className="terminal-placeholder">No gateway logs yet.</p>
              )}
            </div>
          </section>
        </>
      )}
    </section>
  );
}
