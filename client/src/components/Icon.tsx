import type { SVGAttributes } from 'react';

export type IconName =
  | 'activity'
  | 'arrowLeft'
  | 'arrowUpRight'
  | 'box'
  | 'check'
  | 'chevronDown'
  | 'chevronRight'
  | 'circleHelp'
  | 'clipboard'
  | 'close'
  | 'copy'
  | 'cpu'
  | 'dashboard'
  | 'database'
  | 'edit'
  | 'file'
  | 'files'
  | 'folder'
  | 'info'
  | 'java'
  | 'lock'
  | 'menu'
  | 'more'
  | 'play'
  | 'plus'
  | 'refresh'
  | 'scissors'
  | 'send'
  | 'server'
  | 'settings'
  | 'square'
  | 'terminal'
  | 'trash'
  | 'users'
  | 'warning'
  | 'wifi';

const paths: Record<IconName, React.ReactNode> = {
  activity: <><path d="M3 12h4l3-9 4 18 3-9h4" /></>,
  arrowLeft: <><path d="m15 18-6-6 6-6" /><path d="M9 12h12" /></>,
  arrowUpRight: <><path d="M7 17 17 7" /><path d="M7 7h10v10" /></>,
  box: <><path d="m21 16-9 5-9-5V8l9-5 9 5z" /><path d="m3.3 7.8 8.7 5 8.7-5" /><path d="M12 22V12.8" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  circleHelp: <><circle cx="12" cy="12" r="9" /><path d="M9.6 9a2.6 2.6 0 1 1 4.9 1.2c-.8 1.1-2.5 1.4-2.5 3" /><path d="M12 17h.01" /></>,
  clipboard: <><rect width="8" height="4" x="8" y="2" rx="1" ry="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /></>,
  close: <><path d="m6 6 12 12" /><path d="m18 6-12 12" /></>,
  copy: <><rect width="12" height="12" x="8" y="8" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  cpu: <><rect width="12" height="12" x="6" y="6" rx="2" /><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" /></>,
  dashboard: <><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" /></>,
  edit: <><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></>,
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>,
  files: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 2v7h7" /><path d="M8 13h8M8 17h8" /></>,
  folder: <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></>,
  java: <><path d="M8.5 16c0 1.5 1.7 2.5 3.8 2.5s3.7-1 3.7-2.5" /><path d="M9 13.5c1.8.8 4.2.8 6 0" /><path d="M12 4c1.3 1.2-1 2.1.2 3.3 1.2 1.2-.9 2.1.3 3.2" /><path d="M7 20h10" /></>,
  lock: <><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></>,
  play: <path d="m8 5 11 7-11 7z" fill="currentColor" stroke="none" />,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  refresh: <><path d="M20 11a8 8 0 1 0 1.4 4.6" /><path d="M20 4v7h-7" /></>,
  scissors: <><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><line x1="20" y1="4" x2="8.12" y2="15.88" /><line x1="14.47" y1="14.48" x2="20" y2="20" /><line x1="8.12" y1="8.12" x2="12" y2="12" /></>,
  send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
  server: <><rect width="18" height="7" x="3" y="3" rx="2" /><rect width="18" height="7" x="3" y="14" rx="2" /><path d="M7 7h.01M7 18h.01" /></>,
  settings: <><path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.2.34a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.2.35a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.2-.35a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.73l.15-.1a2 2 0 0 0 .73-2.73l-.2-.34a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" /><circle cx="12" cy="12" r="3" /></>,
  square: <rect width="11" height="11" x="6.5" y="6.5" rx="1" fill="currentColor" stroke="none" />,
  terminal: <><path d="m5 17 4-4-4-4" /><path d="M12 19h7" /><rect width="20" height="16" x="2" y="4" rx="2" /></>,
  trash: <><path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v5M14 11v5" /></>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
  warning: <><path d="m10.3 4.5-7 12.1A2 2 0 0 0 5 19.5h14a2 2 0 0 0 1.7-2.9l-7-12.1a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 16h.01" /></>,
  wifi: <><path d="M12 20h.01" /><path d="M2 8.82a15 15 0 0 1 20 0" /><path d="M5 12.859a10 10 0 0 1 14 0" /><path d="M8.5 16.429a5 5 0 0 1 7 0" /></>,
};

export function Icon({ name, size = 20, ...props }: { name: IconName; size?: number } & SVGAttributes<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
