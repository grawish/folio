export type TemplateId =
  'classic' | 'modern' | 'academic' | 'minimal' | 'compact-technical' | 'two-column';
export type Appearance = 'light' | 'dark' | 'system';
export type ProjectFile = { path: string; content: string };
export type RemovedProjectFile = ProjectFile & {
  id: string;
  removedAt: string;
  reason: 'removed' | 'disk-copy' | 'editor-copy';
};
export type Project = {
  id: string;
  name: string;
  mainFile: string;
  files: ProjectFile[];
  removedFiles?: RemovedProjectFile[];
  templateId?: TemplateId;
  templateVersion?: number;
  directory?: string;
  revision: number;
  runtime?: import('./runtime').RuntimePin;
};
export type Diagnostic = {
  severity: 'error' | 'warning';
  message: string;
  file?: string;
  line?: number;
};
export type BuildResult = {
  projectId: string;
  revision: number;
  status: 'success' | 'error' | 'cancelled';
  pdf?: Uint8Array;
  durationMs: number;
  diagnostics: Diagnostic[];
  log: string;
  versionId?: string;
  runtimeUnavailable?: boolean;
};
export type RuntimeStatus = {
  ready: boolean;
  engine: string;
  bundle: string;
  platform: string;
  isolation: 'macos-seatbelt' | 'unavailable';
  message: string;
  pin?: import('./runtime').RuntimePin;
  defaultPin?: import('./runtime').RuntimePin;
  canRepair?: boolean;
};
export type RecentProject = { path: string; name: string };
export type Bootstrap = {
  runtime: RuntimeStatus;
  recovered: Project | null;
  recent: RecentProject[];
  interruptedImportCount: number;
};
export type SaveResult = {
  saved: boolean;
  directory?: string;
  projectId?: string;
  conflict?: boolean;
  warning?: string;
  removedFiles?: RemovedProjectFile[];
};

export type ProjectImportPreview = {
  token: string;
  name: string;
  mainFiles: string[];
  suggestedMain: string;
  sourceCount: number;
  assetCount: number;
  bytes: number;
  hasHistory: boolean;
  skipped: string[];
};

export type InterruptedImport = {
  id: string;
  name: string;
  directory: string | null;
  hasFolder: boolean;
  createdAt: string;
  state: 'preparing' | 'partial' | 'complete' | 'discarding' | 'blocked';
  message: string;
  canResume: boolean;
  canDiscard: boolean;
};

export type ProjectDiskChanges = {
  projectId: string;
  token: string;
  changes: {
    path: string;
    kind: 'source' | 'asset' | 'project';
    change: 'added' | 'modified' | 'removed';
  }[];
  mainFiles: string[];
  error?: string;
};

export interface DesktopAPI {
  beginFontImport(id: string, project: Project): Promise<void>;
  chooseFont(
    id: string,
    style: import('./fonts').FontStyle,
  ): Promise<import('./fonts').SelectedFont | null>;
  removeFont(id: string, style: import('./fonts').FontStyle): Promise<void>;
  previewFonts(
    id: string,
    project: Project,
    target: import('./fonts').FontTarget,
  ): Promise<import('./fonts').FontPreview>;
  applyFonts(id: string, project: Project): Promise<import('./fonts').FontApplyResult>;
  cancelFontImport(id?: string): Promise<void>;
  bootstrap(): Promise<Bootstrap>;
  inspectRuntime(pin?: import('./runtime').RuntimePin): Promise<RuntimeStatus>;
  repairRuntime(pin?: import('./runtime').RuntimePin): Promise<RuntimeStatus>;

  prepareCompilerMigration(
    id: string,
    project: Project,
  ): Promise<import('./migration').CompilerComparison>;
  applyCompilerMigration(
    id: string,
    project: Project,
  ): Promise<import('./migration').CompilerMigrationResult>;
  cancelCompilerMigration(id?: string): Promise<void>;
  compilerBackups(projectId: string): Promise<import('./migration').CompilerBackup[]>;
  showCompilerBackup(projectId: string, id: string): Promise<void>;

  setAppearance(appearance: Appearance): Promise<void>;

  openProject(): Promise<Project | null>;

  openFolder(): Promise<Project | null>;

  prepareImport(): Promise<ProjectImportPreview | null>;

  finishImport(token: string, mainFile: string): Promise<Project | null>;

  cancelImport(token: string): Promise<void>;
  interruptedImports(): Promise<InterruptedImport[]>;
  resumeImport(id: string): Promise<Project>;
  acknowledgeImport(id: string): Promise<void>;
  discardImport(id: string): Promise<void>;
  forgetImport(id: string): Promise<void>;
  showImportFolder(id: string): Promise<void>;

  openRecent(path: string): Promise<Project | null>;

  recentProjects(): Promise<RecentProject[]>;

  watchProject(id: string | null): Promise<ProjectDiskChanges | null>;
  checkProjectChanges(id: string): Promise<ProjectDiskChanges | null>;
  useDiskSource(project: Project, token: string, mainFile: string): Promise<Project>;
  onProjectChanges(callback: (report: ProjectDiskChanges) => void): () => void;

  saveProject(project: Project, saveAs?: boolean): Promise<SaveResult>;
  autosaveProject(project: Project): Promise<SaveResult>;

  recover(project: Project): Promise<void>;

  clearRecovery(): Promise<void>;

  compile(project: Project): Promise<BuildResult>;

  cancelBuild(): Promise<void>;

  exportPdf(project: Project): Promise<boolean>;

  exportSource(project: Project): Promise<boolean>;

  openExternal(url: string): Promise<void>;

  closeWindow(): Promise<void>;

  onMenu(callback: (action: string) => void): () => void;

  loadWorkspace(projectId: string): Promise<import('./ai').WorkspaceState>;
  saveWorkspace(state: import('./ai').WorkspaceState): Promise<void>;
  readVersion(projectId: string, versionId: string): Promise<import('./ai').VersionSnapshot>;
  getAISettings(): Promise<import('./ai').AISettings>;
  saveAIConnection(connection: import('./ai').ConnectionInput): Promise<import('./ai').AISettings>;
  removeAIConnection(id: string): Promise<import('./ai').AISettings>;
  selectAIConnection(id: string | null): Promise<import('./ai').AISettings>;
  checkAIConnection(id: string, testImages?: boolean): Promise<import('./ai').ConnectionStatus>;
  loginAIConnection(id: string): Promise<import('./ai').LoginResult>;
  cancelAILogin(id: string): Promise<void>;
  runAgent(input: import('./ai').AgentInput): Promise<import('./ai').AgentResult>;
  cancelAgent(runId: string): Promise<void>;
  completePdfRender(
    requestId: string,
    result: import('./ai').RenderedPdf | { error: string },
  ): Promise<void>;
  onAgentProgress(callback: (event: import('./ai').AgentProgress) => void): () => void;
  onRenderPdf(callback: (event: import('./ai').RenderPdfRequest) => void): () => void;
}

declare global {
  interface Window {
    folio?: DesktopAPI;
  }
}
