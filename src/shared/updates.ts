export type UpdateChannel = 'stable' | 'beta';
export type UpdatePreferences = { channel: UpdateChannel; automatic: boolean };
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'current'
  | 'waiting'
  | 'incompatible'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'restarting'
  | 'error';
export type AppUpdateStatus = UpdatePreferences & {
  currentVersion: string;
  phase: UpdatePhase;
  canInstall: boolean;
  installReason?: string;
  message: string;
  checkedAt?: string;
  version?: string;
  releaseNotes?: string;
  releasePage?: string;
  received?: number;
  total?: number;
  previousAttempt?: string;
};

// Increment when a new release writes local data that older releases cannot
// read. A release must explicitly advertise support for the installed epoch.
export const APP_DATA_EPOCH = 1;
export const APP_RELEASES_PAGE = 'https://github.com/grawish/folio/releases';
