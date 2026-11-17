import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { ApiError } from "../api";
import {
  browserAccessApi,
  type BrowserAccessStatus,
  type BrowserAccount,
} from "../browser-access-api";
import { Icon } from "../components/Icon";
import type { Server } from "../types";
import { errorMessage, formatDate, titleCase } from "../utils";
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
  const [accounts, setAccounts] = useState<BrowserAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<string>();
  const [error, setError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [approved, setApproved] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [resetAccount, setResetAccount] = useState<BrowserAccount>();
  const [resetPassword, setResetPassword] = useState("");
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const [next, listing] = await Promise.all([
        browserAccessApi.status(server.id),
        browserAccessApi.accounts(server.id),
      ]);
      if (request !== sequence.current) return;
      setStatus(next);
      setAccounts(listing.accounts);
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

  const createAccount = async (event: FormEvent) => {
    event.preventDefault();
    if (!stopped || busy) return;
    await run(
      "account",
      async () => {
        await browserAccessApi.createAccount(server.id, name, password);
        setName("");
        setPassword("");
      },
      "Browser account created. Share its name and password privately with the player.",
    );
  };

  const savePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!resetAccount) return;
    await run(
      "password",
      async () => {
        await browserAccessApi.resetPassword(
          server.id,
          resetAccount.id,
          resetPassword,
        );
        setResetAccount(undefined);
        setResetPassword("");
      },
      "Browser password reset. The previous password will no longer work.",
    );
  };

  const revoke = async (account: BrowserAccount) => {
    if (
      !window.confirm(
        `Revoke browser access for ${account.name}?\n\nThis account will no longer be able to log in.`,
      )
    )
      return;
    await run(
      "revoke",
      () => browserAccessApi.revokeAccount(server.id, account.id),
      `${account.name} can no longer log in.`,
    );
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
          <p className="eyebrow">EAGLERCRAFT CONNECTIONS</p>
          <h3>Browser Players</h3>
          <p>
            Manage browser-player accounts and a public WebSocket address for
            this server.
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
                  Paste this address into a compatible Eaglercraft client, then
                  sign in with the browser account created below.
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
                        : "Enable"}
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

          {status.configured && (
            <section className="panel management-panel">
              <div className="panel-heading">
                <div>
                  <h3>Browser login</h3>
                  <p>{status.requirePassword !== false
                    ? "Players use their NodePilot browser account and password. Clients must support the password prompt."
                    : "Open access: players join without a NodePilot password. You can install a server login plugin to protect their accounts."}</p>
                </div>
              </div>
              <label className="browser-approval">
                <input type="checkbox" checked={status.requirePassword !== false} disabled={!canChange}
                  onChange={(event) => {
                    const required = event.target.checked;
                    if (!window.confirm(required
                      ? "Require NodePilot browser passwords? Only registered browser accounts will be able to join. The gateway will restart and its temporary address will change."
                      : "Allow browser players to join without a NodePilot password? Anyone can use an unrevoked browser name. Install a server login plugin if you want to protect player identities. The gateway will restart and its temporary address will change.")) return;
                    void run("settings", () => browserAccessApi.settings(server.id, required), "Browser login setting saved. Wait for the gateway, then copy its new address.");
                  }} />
                <span>Require NodePilot browser passwords</span>
              </label>
              <p className="input-note">Stop Minecraft before changing this setting. Browser names use the np_ prefix and retain their UUID and progress. Java account authentication stays enabled.</p>
              {status.requirePassword === false && <p className="input-note">Use the same player name each time (1–13 letters, numbers or underscores, with an optional np_ prefix). Existing browser accounts keep their progress; revoked names remain blocked. NodePilot accounts do not protect names while open access is enabled.</p>}
            </section>
          )}

          {status.preview && (
            <section
              className="panel management-panel browser-preview"
              aria-labelledby="browser-preview-heading"
            >
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">REVIEW BEFORE APPLYING</p>
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
                  I approve these connection and authentication changes and
                  understand that browser players use separate local identities.
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

          {available && (
            <section className="panel management-panel">
              <div className="panel-heading">
                <div>
                  <h3>Browser accounts</h3>
                  <p>
                    {status.requirePassword === false
                      ? "Accounts are optional in open-access mode. Players can join without a NodePilot password; names use the np_ prefix and keep a stable UUID. Revoked account names remain blocked."
                      : <>Create a separate account for each player. Browser names use the reserved <code>np_</code> prefix and keep a stable UUID. Players must set their Eaglercraft profile username to the full account name before joining, then enter its password.</>}
                  </p>
                </div>
                <span className="status-pill is-offline">
                  {accounts.filter((account) => !account.revokedAt).length}{" "}
                  active
                </span>
              </div>
              <form
                className="browser-account-form"
                onSubmit={(event) => void createAccount(event)}
              >
                <label className="field-group">
                  <span>Browser username</span>
                  <div className="browser-name-input">
                    <span aria-hidden="true">np_</span>
                    <input
                      aria-label="Browser username"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      pattern="[A-Za-z0-9_]{1,13}"
                      minLength={1}
                      maxLength={13}
                      placeholder="alex"
                      autoComplete="off"
                      required
                      disabled={busy || !stopped}
                    />
                  </div>
                  <small className="input-note">
                    1–13 letters, numbers or underscores after the prefix.
                  </small>
                </label>
                <label className="field-group">
                  <span>Account password</span>
                  <input
                    type="password"
                    aria-label="Account password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    minLength={4}
                    maxLength={127}
                    autoComplete="new-password"
                    required
                    disabled={busy || !stopped}
                  />
                  <small className="input-note">
                    Use 4–127 characters. Share the password privately.
                  </small>
                </label>
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={busy || !stopped || !name || password.length < 4}
                >
                  <Icon name="plus" size={16} />{" "}
                  {action === "account" ? "Creating…" : "Create Account"}
                </button>
              </form>
              {!stopped && (
                <p className="input-note">
                  Stop Minecraft before creating a browser account so NodePilot
                  can reserve its name against saved Java player and operator
                  identities. Password reset and revocation remain available.
                </p>
              )}
              {accounts.length === 0 ? (
                <p className="browser-empty">
                  No browser accounts yet. Create one before sharing your server
                  address.
                </p>
              ) : (
                <div className="browser-account-list">
                  {accounts.map((account) => (
                    <article className="browser-account" key={account.id}>
                      <div>
                        <strong>{account.name}</strong>
                        <code>{account.uuid}</code>
                        <small>
                          {account.revokedAt
                            ? `Revoked ${formatDate(account.revokedAt)}`
                            : `Created ${formatDate(account.createdAt)}`}
                        </small>
                      </div>
                      <div className="browser-account-actions">
                        <button
                          type="button"
                          className="button button-secondary button-small"
                          disabled={busy || Boolean(account.revokedAt)}
                          onClick={() => {
                            setResetAccount(account);
                            setResetPassword("");
                          }}
                        >
                          Reset Password
                        </button>
                        <button
                          type="button"
                          className="button button-danger-outline button-small"
                          disabled={busy || Boolean(account.revokedAt)}
                          onClick={() => void revoke(account)}
                        >
                          Revoke
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
              {resetAccount && (
                <form
                  className="browser-reset-form"
                  onSubmit={(event) => void savePassword(event)}
                >
                  <label className="field-group">
                    <span>New password for {resetAccount.name}</span>
                    <input
                      type="password"
                      aria-label={`New password for ${resetAccount.name}`}
                      value={resetPassword}
                      onChange={(event) => setResetPassword(event.target.value)}
                      minLength={4}
                      maxLength={127}
                      autoComplete="new-password"
                      required
                      autoFocus
                      disabled={busy}
                    />
                  </label>
                  <button
                    type="submit"
                    className="button button-primary"
                    disabled={busy || resetPassword.length < 4}
                  >
                    Save Password
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => {
                      setResetAccount(undefined);
                      setResetPassword("");
                    }}
                  >
                    Cancel
                  </button>
                </form>
              )}
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
