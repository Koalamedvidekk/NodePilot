import type { ServerStatus } from '../types';

const labels: Record<ServerStatus, string> = {
  running: 'Online',
  stopped: 'Offline',
  installing: 'Installing',
  starting: 'Starting',
  stopping: 'Stopping',
  error: 'Needs attention',
  unknown: 'Unknown',
};

export function StatusBadge({ status, directoryMissing }: { status: ServerStatus; directoryMissing?: boolean }) {
  if (directoryMissing) {
    return (
      <span className="status-badge status-error">
        <span className="status-dot" />
        Missing folder
      </span>
    );
  }
  return (
    <span className={`status-badge status-${status}`}>
      <span className="status-dot" />
      {labels[status]}
    </span>
  );
}
