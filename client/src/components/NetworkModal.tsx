import { useState } from 'react';
import { api } from '../api';
import { Icon } from './Icon';
import type { NetworkInfo } from '../types';
import { errorMessage } from '../utils';

interface NetworkModalProps {
  network: NetworkInfo;
  onClose: () => void;
  onRefresh: () => void;
}

export function NetworkModal({ network, onClose, onRefresh }: NetworkModalProps) {
  const [mode, setMode] = useState<'127.0.0.1' | '0.0.0.0'>(network.isNetworkVisible ? '0.0.0.0' : '127.0.0.1');
  const [pinEnabled, setPinEnabled] = useState(network.hasPin);
  const [pin, setPin] = useState('');
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const copyToClipboard = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      setTimeout(() => setCopiedUrl(null), 2000);
    } catch {
      // Fallback
      setCopiedUrl(url);
      setTimeout(() => setCopiedUrl(null), 2000);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSavedMessage(null);

    try {
      const pinValue = pinEnabled ? (pin.trim() || undefined) : null;
      const res = await api.updateNetwork({
        host: mode,
        pin: pinValue,
      });

      setSavedMessage(res.message || 'Network settings saved to .env!');
      onRefresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal network-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="network-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="network-modal-heading">
            <Icon name={network.isNetworkVisible ? 'wifi' : 'server'} size={20} />
            <h4 id="network-modal-title">Network & Remote Access</h4>
          </div>
          <button type="button" className="button-icon-only" onClick={onClose} aria-label="Close dialog">
            <Icon name="close" size={16} />
          </button>
        </div>

        <form onSubmit={(e) => void handleSave(e)}>
          <div className="modal-body">
            {/* Status overview */}
            <div className={`network-status-banner ${network.isNetworkVisible ? 'is-lan' : 'is-local'}`}>
              <div className="network-status-icon">
                <Icon name={network.isNetworkVisible ? 'wifi' : 'box'} size={24} />
              </div>
              <div className="network-status-text">
                <strong>{network.isNetworkVisible ? 'Visible on Local Network (LAN)' : 'Local PC Only'}</strong>
                <p>
                  {network.isNetworkVisible
                    ? 'NodePilot is accessible from other computers, laptops, and phones on your Wi-Fi.'
                    : 'NodePilot is only accessible from this computer (127.0.0.1).'}
                </p>
              </div>
            </div>

            {/* Remote URLs if available */}
            {network.accessUrls.network.length > 0 && (
              <div className="network-links-section">
                <span className="field-label">Remote Control URLs (Open on main laptop/PC):</span>
                <div className="network-urls-list">
                  {network.accessUrls.network.map((url) => (
                    <div className="network-url-card" key={url}>
                      <code>{url}</code>
                      <button
                        type="button"
                        className="button button-secondary button-sm"
                        onClick={() => void copyToClipboard(url)}
                      >
                        <Icon name={copiedUrl === url ? 'check' : 'copy'} size={14} />
                        {copiedUrl === url ? 'Copied!' : 'Copy Link'}
                      </button>
                    </div>
                  ))}
                </div>
                <p className="network-hint">
                  💡 Connect your main laptop to the same Wi-Fi and open this URL in any browser.
                </p>
              </div>
            )}

            {/* Mode selection */}
            <div className="network-mode-selector">
              <span className="field-label">Access Mode</span>
              <div className="network-mode-options">
                <label className={`network-mode-card ${mode === '127.0.0.1' ? 'is-selected' : ''}`}>
                  <input
                    type="radio"
                    name="networkMode"
                    value="127.0.0.1"
                    checked={mode === '127.0.0.1'}
                    onChange={() => setMode('127.0.0.1')}
                  />
                  <div>
                    <strong>Local only (127.0.0.1)</strong>
                    <p>Only accessible directly on this computer.</p>
                  </div>
                </label>
                <label className={`network-mode-card ${mode === '0.0.0.0' ? 'is-selected' : ''}`}>
                  <input
                    type="radio"
                    name="networkMode"
                    value="0.0.0.0"
                    checked={mode === '0.0.0.0'}
                    onChange={() => setMode('0.0.0.0')}
                  />
                  <div>
                    <strong>Local Network / LAN (0.0.0.0)</strong>
                    <p>Control this machine remotely from other devices on your Wi-Fi.</p>
                  </div>
                </label>
              </div>
            </div>

            {/* PIN Protection */}
            <div className="network-pin-section">
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={pinEnabled}
                  onChange={(e) => setPinEnabled(e.target.checked)}
                />
                <span>Protect with access PIN / password</span>
              </label>

              {pinEnabled && (
                <div className="pin-input-wrap">
                  <label className="form-field">
                    <span className="field-label">
                      {network.hasPin ? 'Update PIN (leave empty to keep current)' : 'Set new access PIN'}
                    </span>
                    <input
                      type="password"
                      className="input"
                      value={pin}
                      onChange={(e) => setPin(e.target.value)}
                      placeholder={network.hasPin ? '••••••••' : 'e.g. 1234'}
                    />
                  </label>
                </div>
              )}
            </div>

            {error && (
              <div className="inline-alert alert-error" role="alert">
                <Icon name="warning" size={16} />
                <span>{error}</span>
              </div>
            )}

            {savedMessage && (
              <div className="inline-alert alert-info" role="status">
                <Icon name="check" size={16} />
                <span>{savedMessage}</span>
              </div>
            )}
          </div>

          <div className="modal-footer">
            <button type="button" className="button button-secondary" onClick={onClose}>
              Close
            </button>
            <button type="submit" className="button button-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save Network Settings'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
