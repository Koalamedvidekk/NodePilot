import { useState } from 'react';
import { api } from '../api';
import { Icon } from './Icon';
import { errorMessage } from '../utils';

interface PinModalProps {
  onSuccess: () => void;
}

export function PinModal({ onSuccess }: PinModalProps) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pin.trim() || busy) return;

    setBusy(true);
    setError(null);

    try {
      const ok = await api.verifyPin(pin.trim());
      if (ok) {
        onSuccess();
      } else {
        setError('Incorrect PIN code. Please try again.');
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop pin-auth-backdrop" role="presentation">
      <div
        className="modal pin-auth-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pin-modal-title"
      >
        <div className="pin-auth-header">
          <div className="pin-lock-icon">
            <Icon name="lock" size={28} />
          </div>
          <h3 id="pin-modal-title">NodePilot Access</h3>
          <p>This server is protected with an access PIN.</p>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className="modal-body">
            <label className="form-field">
              <span className="field-label">Enter Access PIN</span>
              <input
                autoFocus
                type="password"
                className="input pin-input"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder="••••"
                disabled={busy}
              />
            </label>

            {error && (
              <div className="inline-alert alert-error" role="alert">
                <Icon name="warning" size={16} />
                <span>{error}</span>
              </div>
            )}
          </div>

          <div className="modal-footer pin-auth-footer">
            <button type="submit" className="button button-primary button-full" disabled={busy || !pin.trim()}>
              {busy ? 'Unlocking…' : 'Unlock Dashboard'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
