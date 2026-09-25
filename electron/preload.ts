import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../src/shared/types';

const api: DesktopAPI = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  inspectRuntime: (pin) => ipcRenderer.invoke('runtime:inspect', pin),
  repairRuntime: (pin) => ipcRenderer.invoke('runtime:repair', pin),
  prepareCompilerMigration: (id, project) => ipcRenderer.invoke('runtime:compare', id, project),
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
  readVersion: (projectId, versionId) =>
    ipcRenderer.invoke('workspace:version', projectId, versionId),
  getAISettings: () => ipcRenderer.invoke('ai:settings'),
  saveAIConnection: (connection) => ipcRenderer.invoke('ai:save', connection),
  removeAIConnection: (id) => ipcRenderer.invoke('ai:remove', id),
  selectAIConnection: (id) => ipcRenderer.invoke('ai:select', id),
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
  onMenu: (callback) => {
    const handler = (_: unknown, action: string) => callback(action);
    ipcRenderer.on('menu', handler);
    return () => ipcRenderer.removeListener('menu', handler);
  },
};
contextBridge.exposeInMainWorld('folio', api);
