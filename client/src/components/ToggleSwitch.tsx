import { type KeyboardEvent } from 'react';

export interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  label?: string;
  size?: 'sm' | 'md';
  variant?: 'purple' | 'cyan';
  className?: string;
}

export function ToggleSwitch({
  checked,
  onChange,
  disabled = false,
  id,
  'aria-label': ariaLabel,
  label,
  size = 'md',
  variant = 'purple',
  className = '',
}: ToggleSwitchProps) {
  const toggle = () => {
    if (!disabled) {
      onChange(!checked);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      onChange(!checked);
    }
  };

  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel ?? label}
      disabled={disabled}
      onClick={toggle}
      onKeyDown={handleKeyDown}
      className={`toggle-switch-button variant-${variant} size-${size} ${checked ? 'is-checked' : ''} ${disabled ? 'is-disabled' : ''} ${className}`}
    >
      <span className="toggle-switch-track">
        <span className="toggle-switch-thumb" />
      </span>
      {label && <span className="toggle-switch-label">{label}</span>}
    </button>
  );
}
