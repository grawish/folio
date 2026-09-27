import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../src/shared/types';
import type { GitDiffTarget, GitOperationProgress } from '../src/shared/git';

const api: DesktopAPI = {
  appUpdateStatus: () => ipcRenderer.invoke('updates:status'),
  configureAppUpdates: (value) => ipcRenderer.invoke('updates:configure', value),
  checkAppUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadAppUpdate: () => ipcRenderer.invoke('updates:download'),
  cancelAppUpdate: () => ipcRenderer.invoke('updates:cancel'),
  restartForAppUpdate: (project, workspace) =>
    ipcRenderer.invoke('updates:restart', project, workspace),
  onAppUpdate: (callback) => {
    const handler = (_: unknown, value: import('../src/shared/updates').AppUpdateStatus) =>
      callback(value);
    ipcRenderer.on('updates:status', handler);
    return () => ipcRenderer.removeListener('updates:status', handler);
  },
  beginSaveRecovery: (id, project) => ipcRenderer.invoke('save-recovery:begin', id, project),
  endSaveRecovery: (id) => ipcRenderer.invoke('save-recovery:end', id),
  interruptedSaves: (id) => ipcRenderer.invoke('save-recovery:list', id),
  reviewSave: (id, record) => ipcRenderer.invoke('save-recovery:review', id, record),
  reviewSaveText: (id, record, token, filename, version) =>
    ipcRenderer.invoke('save-recovery:text', id, record, token, filename, version),
  resolveSave: (id, record, token, choices) =>
    ipcRenderer.invoke('save-recovery:apply', id, record, token, choices),
  showSaveRecoveryFolder: (id, record, kind) =>
    ipcRenderer.invoke('save-recovery:show', id, record, kind),
  prepareSupportBundle: (context) => ipcRenderer.invoke('support:prepare', context),
  exportSupportBundle: (id, selected) => ipcRenderer.invoke('support:export', id, selected),
  cancelSupportBundle: (id) => ipcRenderer.invoke('support:cancel', id),
  beginFontImport: (id, project) => ipcRenderer.invoke('fonts:begin', id, project),
  chooseFont: (id, style) => ipcRenderer.invoke('fonts:choose', id, style),
  removeFont: (id, style) => ipcRenderer.invoke('fonts:remove', id, style),
  previewFonts: (id, project, target) => ipcRenderer.invoke('fonts:preview', id, project, target),
  applyFonts: (id, project) => ipcRenderer.invoke('fonts:apply', id, project),
  cancelFontImport: (id) => ipcRenderer.invoke('fonts:cancel', id),
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  inspectRuntime: (pin) => ipcRenderer.invoke('runtime:inspect', pin),
  repairRuntime: (pin) => ipcRenderer.invoke('runtime:repair', pin),
  listPacks: () => ipcRenderer.invoke('packs:list'),
  refreshPacks: (id) => ipcRenderer.invoke('packs:refresh', id),
  preparePackImport: (id) => ipcRenderer.invoke('packs:import', id),
  installPack: (id, key, source) => ipcRenderer.invoke('packs:install', id, key, source),
  removePackDownload: (id, key) => ipcRenderer.invoke('packs:remove-download', id, key),
  cancelPackOperation: (id) => ipcRenderer.invoke('packs:cancel', id),
  onPackProgress: (callback) => {
    const handler = (_: unknown, value: import('../src/shared/packs').PackActivity) =>
      callback(value);
    ipcRenderer.on('packs:progress', handler);
    return () => ipcRenderer.removeListener('packs:progress', handler);
  },
  prepareCompilerMigration: (id, project, target) =>
    ipcRenderer.invoke('runtime:compare', id, project, target),
  applyCompilerMigration: (id, project) => ipcRenderer.invoke('runtime:apply', id, project),
  cancelCompilerMigration: (id) => ipcRenderer.invoke('runtime:cancel-comparison', id),
  compilerBackups: (projectId) => ipcRenderer.invoke('runtime:backups', projectId),
  showCompilerBackup: (projectId, id) => ipcRenderer.invoke('runtime:show-backup', projectId, id),
  setAppearance: (appearance) => ipcRenderer.invoke('app:appearance', appearance),
  openProject: () => ipcRenderer.invoke('project:open'),
  openFolder: () => ipcRenderer.invoke('project:open-folder'),
  prepareImport: () => ipcRenderer.invoke('project:prepare-import'),
  interruptedImports: () => ipcRenderer.invoke('project:interrupted-imports'),
  resumeImport: (id) => ipcRenderer.invoke('project:resume-import', id),
  acknowledgeImport: (id) => ipcRenderer.invoke('project:acknowledge-import', id),
  discardImport: (id) => ipcRenderer.invoke('project:discard-import', id),
  forgetImport: (id) => ipcRenderer.invoke('project:forget-import', id),
  showImportFolder: (id) => ipcRenderer.invoke('project:show-import', id),
  finishImport: (token, mainFile) => ipcRenderer.invoke('project:finish-import', token, mainFile),
  cancelImport: (token) => ipcRenderer.invoke('project:cancel-import', token),
  openRecent: (path) => ipcRenderer.invoke('project:recent', path),
  recentProjects: () => ipcRenderer.invoke('project:recent-list'),
  watchProject: (id) => ipcRenderer.invoke('project:watch', id),
  checkProjectChanges: (id) => ipcRenderer.invoke('project:changes', id),
  useDiskSource: (project, token, mainFile) =>
    ipcRenderer.invoke('project:use-disk-source', project, token, mainFile),
  onProjectChanges: (callback) => {
    const handler = (_: unknown, report: import('../src/shared/types').ProjectDiskChanges) =>
      callback(report);
    ipcRenderer.on('project:changes', handler);
    return () => ipcRenderer.removeListener('project:changes', handler);
  },
  saveProject: (project, saveAs) => ipcRenderer.invoke('project:save', project, saveAs),
  autosaveProject: (project) => ipcRenderer.invoke('project:autosave', project),
  recover: (project) => ipcRenderer.invoke('project:recover', project),
  clearRecovery: () => ipcRenderer.invoke('project:clear-recovery'),
  compile: (project) => ipcRenderer.invoke('build:compile', project),
  cancelBuild: () => ipcRenderer.invoke('build:cancel'),
  exportPdf: (project) => ipcRenderer.invoke('project:export-pdf', project),
  exportSource: (project) => ipcRenderer.invoke('project:export-source', project),
  openExternal: (url) => ipcRenderer.invoke('app:external', url),
  closeWindow: () => ipcRenderer.invoke('app:close'),
  loadWorkspace: (id) => ipcRenderer.invoke('workspace:load', id),
  saveWorkspace: (state) => ipcRenderer.invoke('workspace:save', state),
  historyStorage: (id) => ipcRenderer.invoke('workspace:storage', id),
  removeHistoryVersion: (id, versionId, currentId) =>
    ipcRenderer.invoke('workspace:remove-version', id, versionId, currentId),
  readVersion: (projectId, versionId) =>
    ipcRenderer.invoke('workspace:version', projectId, versionId),
  getAISettings: () => ipcRenderer.invoke('ai:settings'),
  saveAIConnection: (connection) => ipcRenderer.invoke('ai:save', connection),
  removeAIConnection: (id) => ipcRenderer.invoke('ai:remove', id),
  selectAIConnection: (id) => ipcRenderer.invoke('ai:select', id),
  getAIModels: (id) => ipcRenderer.invoke('ai:models', id),
  selectAIModel: (id, selection) => ipcRenderer.invoke('ai:model', id, selection),
  checkAIConnection: (id, testImages) => ipcRenderer.invoke('ai:check', id, testImages),
  loginAIConnection: (id) => ipcRenderer.invoke('ai:login', id),
  cancelAILogin: (id) => ipcRenderer.invoke('ai:cancel-login', id),
  runAgent: (input) => ipcRenderer.invoke('agent:run', input),
  cancelAgent: (id) => ipcRenderer.invoke('agent:cancel', id),
  completePdfRender: (id, result) => ipcRenderer.invoke('agent:rendered', id, result),
  onAgentProgress: (callback) => {
    const handler = (_: unknown, event: import('../src/shared/ai').AgentProgress) =>
      callback(event);
    ipcRenderer.on('agent:progress', handler);
    return () => ipcRenderer.removeListener('agent:progress', handler);
  },
  onRenderPdf: (callback) => {
    const handler = (_: unknown, event: import('../src/shared/ai').RenderPdfRequest) =>
      callback(event);
    ipcRenderer.on('agent:render', handler);
    return () => ipcRenderer.removeListener('agent:render', handler);
  },
  gitAvailability: () => ipcRenderer.invoke('git:availability'),
  gitStatus: (projectId) => ipcRenderer.invoke('git:status', projectId),
  gitInit: (projectId) => ipcRenderer.invoke('git:init', projectId),
  gitClone: (id, url, directory) => ipcRenderer.invoke('git:clone', id, url, directory),
  gitDiff: (projectId, target: GitDiffTarget) => ipcRenderer.invoke('git:diff', projectId, target),
  gitStage: (projectId, paths) => ipcRenderer.invoke('git:stage', projectId, paths),
  gitUnstage: (projectId, paths) => ipcRenderer.invoke('git:unstage', projectId, paths),
  gitApplyPatch: (projectId, patch, options) =>
    ipcRenderer.invoke('git:apply-patch', projectId, patch, options),
  gitCommit: (projectId, message) => ipcRenderer.invoke('git:commit', projectId, message),
  gitLog: (projectId, options) => ipcRenderer.invoke('git:log', projectId, options),
  gitRestoreFiles: (projectId, hash, paths) =>
    ipcRenderer.invoke('git:restore-files', projectId, hash, paths),
  gitRevertCommit: (projectId, hash) => ipcRenderer.invoke('git:revert-commit', projectId, hash),
  gitBranches: (projectId) => ipcRenderer.invoke('git:branches', projectId),
  gitCreateBranch: (projectId, name, switchTo) =>
    ipcRenderer.invoke('git:create-branch', projectId, name, switchTo),
  gitSwitchBranch: (projectId, name) => ipcRenderer.invoke('git:switch-branch', projectId, name),
  gitRenameBranch: (projectId, from, to) =>
    ipcRenderer.invoke('git:rename-branch', projectId, from, to),
  gitDeleteBranch: (projectId, name, force) =>
    ipcRenderer.invoke('git:delete-branch', projectId, name, force),
  gitMerge: (projectId, branch) => ipcRenderer.invoke('git:merge', projectId, branch),
  gitMergeContinue: (projectId) => ipcRenderer.invoke('git:merge-continue', projectId),
  gitMergeAbort: (projectId) => ipcRenderer.invoke('git:merge-abort', projectId),
  gitConflict: (projectId, path) => ipcRenderer.invoke('git:conflict', projectId, path),
  gitResolveConflict: (projectId, path, resolution) =>
    ipcRenderer.invoke('git:resolve-conflict', projectId, path, resolution),
  gitStashes: (projectId) => ipcRenderer.invoke('git:stashes', projectId),
  gitStashSave: (projectId, message) => ipcRenderer.invoke('git:stash-save', projectId, message),
  gitStashShow: (projectId, index) => ipcRenderer.invoke('git:stash-show', projectId, index),
  gitStashApply: (projectId, index, pop) =>
    ipcRenderer.invoke('git:stash-apply', projectId, index, pop),
  gitStashDrop: (projectId, index) => ipcRenderer.invoke('git:stash-drop', projectId, index),
  gitRemotes: (projectId) => ipcRenderer.invoke('git:remotes', projectId),
  gitAddRemote: (projectId, name, url) => ipcRenderer.invoke('git:add-remote', projectId, name, url),
  gitRemoveRemote: (projectId, name) => ipcRenderer.invoke('git:remove-remote', projectId, name),
  gitFetch: (id, projectId, remote) => ipcRenderer.invoke('git:fetch', id, projectId, remote),
  gitPull: (id, projectId) => ipcRenderer.invoke('git:pull', id, projectId),
  gitPush: (id, projectId, options) => ipcRenderer.invoke('git:push', id, projectId, options),
  gitCancel: (id) => ipcRenderer.invoke('git:cancel', id),
  onGitProgress: (callback) => {
    const handler = (_: unknown, event: GitOperationProgress) => callback(event);
    ipcRenderer.on('git:progress', handler);
    return () => ipcRenderer.removeListener('git:progress', handler);
  },
  onMenu: (callback) => {
    const handler = (_: unknown, action: string) => callback(action);
    ipcRenderer.on('menu', handler);
    return () => ipcRenderer.removeListener('menu', handler);
  },
};
contextBridge.exposeInMainWorld('folio', api);
