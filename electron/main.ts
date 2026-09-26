import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  session,
  shell,
  safeStorage,
} from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { ProjectStore, atomicWrite, validateProject, removedFileArchive } from './core/project';
import { ProjectImporter } from './core/project-import';
import { ProjectWatcher } from './core/project-scan';
import { Compiler } from './core/compiler';
import { RuntimeManager } from './core/runtime-manager';
import { CompilerMigration } from './core/compiler-migration';
import { FontImport } from './core/font-import';
import type { FontStyle, FontTarget } from '../src/shared/fonts';
import { adoptRuntime, validateRuntimePin } from '../src/shared/runtime';
import { WorkspaceStore, safeId } from './core/workspace';
import { ConnectionStore } from './core/connections';
import { ProviderService } from './core/ai-provider';
import { ResumeAgent, validateRenderedPdf } from './core/agent';
import type { PdfAnnotation, RenderedPdf } from '../src/shared/ai';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'folio',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
if (process.env.FOLIO_USER_DATA) app.setPath('userData', path.resolve(process.env.FOLIO_USER_DATA));
let window: BrowserWindow | null = null;
// Two app processes must not recover or write the same profile's save journals.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance', () => {
  if (window?.isMinimized()) window.restore();
  window?.show();
  window?.focus();
});
let closing = false;
let store: ProjectStore;
let watcher: ProjectWatcher;
let watchedDirectory: string | undefined;
let importer: ProjectImporter;
let compiler: Compiler;
let runtimes: RuntimeManager;
let agentCompiler: Compiler;
let migrationCompiler: Compiler;
let migrations: CompilerMigration;
let fonts: FontImport;
let workspaces: WorkspaceStore;
let connections: ConnectionStore;
let providers: ProviderService;
let agent: ResumeAgent;
const renders = new Map<
  string,
  { resolve(value: RenderedPdf): void; reject(error: Error): void }
>();
let recoveryQueue = Promise.resolve();
let requestGeneration = 0;
nativeTheme.themeSource = 'dark';
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#101c2b' : '#eef3f7');
nativeTheme.on('updated', () => window?.setBackgroundColor(windowBackground()));
const runtimeRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'runtime')
  : path.join(
      app.getAppPath(),
      'resources/runtime',
      `${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}-${process.arch}`,
    );
const devUrl = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined;

function renderPdf(
  runId: string,
  pdf: Uint8Array,
  annotations: PdfAnnotation[],
  signal: AbortSignal,
): Promise<RenderedPdf> {
  signal.throwIfAborted();
  if (!window || window.isDestroyed())
    return Promise.reject(new Error('Open Folio to review the PDF.'));
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const cleanup = () => {
      clearTimeout(timer);
      renders.delete(requestId);
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(new Error('PDF review cancelled.'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('The PDF could not be rendered in time. Try again.'));
    }, 45_000);
    renders.set(requestId, {
      resolve: (value) => {
        cleanup();
        resolve(value);
      },
      reject: (error) => {
        cleanup();
        reject(error);
      },
    });
    signal.addEventListener('abort', abort, { once: true });
    window!.webContents.send('agent:render', { requestId, runId, pdf, annotations });
  });
}

async function openProject(directory: string, main?: string) {
  requireProjectIdle();
  const project = await store.open(directory, main);
  await workspaces.importFrom(project.id, project.directory!);
  return project;
}

function requireProjectIdle() {
  migrations.requireIdle();
  fonts.requireIdle();
}

function handle(channel: string, callback: (...args: any[]) => unknown) {
  ipcMain.handle(channel, (event, ...args) => {
    const url = event.senderFrame?.url ?? '';
    const allowed = devUrl
      ? new URL(url).origin === new URL(devUrl).origin
      : url.startsWith('folio://app/');
    if (
      event.sender !== window?.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      !allowed
    )
      throw new Error('Unauthorized application request.');
    return callback(...args);
  });
}

function registerHandlers() {
  const checkedProject = (value: unknown) => {
    const project = validateProject(value);
    return { ...project, runtime: adoptRuntime(project.runtime, runtimes.defaultPin) };
  };
  handle('runtime:inspect', (pin: unknown) => runtimes.status(validateRuntimePin(pin)));
  handle('runtime:repair', (pin: unknown) => runtimes.repair(validateRuntimePin(pin)));
  handle('runtime:compare', (id: string, value: unknown) => {
    requireProjectIdle();
    return migrations.prepare(id, checkedProject(value));
  });
  handle('fonts:begin', (id: string, value: unknown) => {
    migrations.requireIdle();
    return fonts.begin(id, checkedProject(value));
  });
  handle('fonts:choose', (id: string, style: FontStyle) => fonts.choose(id, style));
  handle('fonts:remove', (id: string, style: FontStyle) => fonts.remove(id, style));
  handle('fonts:preview', (id: string, value: unknown, target: FontTarget) =>
    fonts.preview(id, checkedProject(value), target),
  );
  handle('fonts:apply', (id: string, value: unknown) => fonts.apply(id, checkedProject(value)));
  handle('fonts:cancel', (id?: string) => fonts.cancel(id));
  handle('runtime:apply', (id: string, value: unknown) =>
    migrations.apply(id, checkedProject(value)),
  );
  handle('runtime:cancel-comparison', (id?: string) => migrations.cancel(id));
  handle('runtime:backups', (projectId: string) => migrations.backups(safeId(projectId)));
  handle('runtime:show-backup', async (projectId: string, id: string) => {
    shell.showItemInFolder(await migrations.backupPath(safeId(projectId), id));
  });
  handle('workspace:load', async (id: string) => {
    id = safeId(id);
    const directory = store.directory(id);
    if (directory) await workspaces.importFrom(id, directory);
    return workspaces.load(id);
  });
  handle('workspace:save', (state: unknown) => workspaces.save(state));
  handle('workspace:version', (projectId: string, versionId: string) =>
    workspaces.version(safeId(projectId), safeId(versionId)),
  );
  handle('ai:settings', () => connections.list());
  handle('ai:save', (input) => connections.save(input));
  handle('ai:remove', (id: string) => {
    providers.cancelLogin(safeId(id));
    return connections.remove(id);
  });
  handle('ai:select', (id: string | null) => connections.select(id === null ? null : safeId(id)));
  handle('ai:check', (id: string, images: boolean) => providers.check(safeId(id), images === true));
  handle('ai:login', async (id: string) => {
    const login = await providers.login(safeId(id));
    if (login.url) await shell.openExternal(login.url);
    return { message: login.message, loginId: login.loginId };
  });
  handle('ai:cancel-login', (id: string) => providers.cancelLogin(safeId(id)));
  handle('agent:run', (input) => {
    requireProjectIdle();
    return agent.run(input);
  });
  handle('agent:cancel', (id: string) => agent.cancel(safeId(id)));
  handle('agent:rendered', (id: string, data: unknown) => {
    const pending = renders.get(safeId(id));
    if (!pending) return;
    if (data && typeof (data as { error?: unknown }).error === 'string') {
      pending.reject(new Error(String((data as { error: string }).error).slice(0, 1000)));
      return;
    }
    try {
      pending.resolve(validateRenderedPdf(data));
    } catch (error) {
      pending.reject(error as Error);
    }
  });
  handle('app:appearance', (value: unknown) => {
    if (value !== 'light' && value !== 'dark' && value !== 'system')
      throw new Error('Invalid appearance.');
    nativeTheme.themeSource = value;
    window?.setBackgroundColor(windowBackground());
  });
  handle('app:bootstrap', async () => {
    // A renderer reload loses its comparison token. Release the abandoned
    // comparison (or wait for Apply) before restoring the recovered draft.
    await fonts.cancel();
    await migrations.cancel();
    await recoveryQueue.catch(() => {});
    await runtimes.initialize();
    const recovered = await store.loadRecovery();
    return {
      runtime: await runtimes.status(recovered?.runtime),
      recovered,
      recent: await store.recent(),
      interruptedImportCount: await importer.recovery.count(),
    };
  });
  handle('project:open', async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: 'Open a LaTeX resume',
      properties: ['openFile'],
      filters: [{ name: 'LaTeX source', extensions: ['tex'] }],
    });
    if (result.canceled) return null;
    return openProject(path.dirname(result.filePaths[0]), path.basename(result.filePaths[0]));
  });
  handle('project:open-folder', async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: 'Open a resume project folder',
      properties: ['openDirectory'],
    });
    if (result.canceled) return null;
    return openProject(result.filePaths[0]);
  });
  handle('project:prepare-import', async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: 'Import a LaTeX project ZIP',
      properties: ['openFile'],
      filters: [{ name: 'ZIP project', extensions: ['zip'] }],
    });
    if (result.canceled) return null;
    return importer.prepare(result.filePaths[0]);
  });
  handle('project:finish-import', async (token: string, mainFile: string) => {
    safeId(token);
    const result = await dialog.showOpenDialog(window!, {
      title: 'Choose where to keep the imported project',
      buttonLabel: 'Create project here',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled) return null;
    const directory = await importer.finish(token, mainFile, result.filePaths[0]);
    try {
      return await openProject(directory, mainFile);
    } catch (error) {
      throw new Error(
        `The imported project is saved at ${directory}, but could not be opened: ${(error as Error).message}`,
      );
    }
  });
  handle('project:cancel-import', (token: string) => importer.cancel(safeId(token)));
  handle('project:interrupted-imports', () => importer.interrupted());
  handle('project:resume-import', async (id: string) => {
    const recovered = await importer.resume(safeId(id));
    return openProject(recovered.directory, recovered.mainFile);
  });
  handle('project:acknowledge-import', (id: string) => importer.recovery.acknowledge(safeId(id)));
  handle('project:discard-import', (id: string) =>
    importer.discard(
      safeId(id),
      (directory) => shell.trashItem(directory),
      (directory) => {
        if (watchedDirectory === directory)
          throw new Error(
            'This imported project is open. Open another project before moving it to Trash.',
          );
      },
    ),
  );
  handle('project:forget-import', (id: string) => importer.forget(safeId(id)));
  handle('project:show-import', async (id: string) => {
    shell.showItemInFolder(await importer.recovery.reveal(safeId(id)));
  });
  handle('project:recent', async (directory: string) => {
    if (!(await store.recent()).some((p) => p.path === directory))
      throw new Error('Choose the project using Open project.');
    return openProject(directory);
  });
  handle('project:recent-list', () => store.recent());
  handle('project:watch', (id: string | null) => {
    if (id !== null) safeId(id);
    watchedDirectory = id ? store.directory(id) : undefined;
    return watcher.start(id, watchedDirectory);
  });
  handle('project:changes', (id: string) => store.inspectChanges(safeId(id)));
  handle('project:use-disk-source', async (value: unknown, token: string, mainFile: string) => {
    requireProjectIdle();
    await recoveryQueue.catch(() => {});
    const next = await store.useDiskSource(value, token, mainFile);
    void watcher.check();
    return next;
  });
  const saveProject = async (value: unknown, saveAs: boolean, automatic = false) => {
    requireProjectIdle();
    const project = checkedProject(value);
    let directory = store.directory(project.id);
    if (automatic && !directory)
      return { saved: false, warning: 'Save this project once before using autosave.' };
    if (!directory || saveAs) {
      const choice = await dialog.showOpenDialog(window!, {
        title: 'Choose a folder for this resume',
        buttonLabel: 'Save project here',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (choice.canceled) return { saved: false };
      directory = choice.filePaths[0];
    }
    const history = (id: string) => workspaces.archive(project.id, id);
    let result = await store.save(
      project,
      automatic ? undefined : directory,
      false,
      history,
      automatic,
    );
    if (result.conflict) {
      if (automatic) return { saved: false, conflict: true };
      const choice = await dialog.showMessageBox(window!, {
        type: 'warning',
        title: 'Files changed on disk',
        message: 'Some files have changed outside Folio or already exist in this folder.',
        detail: 'Keep the files on disk, or replace them with the version in your editor.',
        buttons: ['Keep files on disk', 'Replace with editor version'],
        defaultId: 0,
        cancelId: 0,
      });
      if (choice.response === 0) return { saved: false, conflict: true };
      result = await store.save(project, directory, true, history);
    }
    const savedProject = {
      ...project,
      id: result.projectId ?? project.id,
      removedFiles: result.removedFiles ?? project.removedFiles,
    };
    const warnings = [result.warning];
    if (savedProject.id !== project.id) {
      try {
        await workspaces.importFrom(savedProject.id, result.directory);
      } catch {
        warnings.push(
          'Project saved with its history. Local history could not be loaded; reopen the saved project to retry.',
        );
      }
    }
    recoveryQueue = recoveryQueue.catch(() => {}).then(() => store.recover(savedProject));
    try {
      await recoveryQueue;
    } catch {
      warnings.push('Project saved, but local recovery could not be updated.');
    }
    return {
      saved: true,
      directory: result.directory,
      projectId: savedProject.id,
      removedFiles: savedProject.removedFiles,
      warning: warnings.filter(Boolean).join(' ') || undefined,
    };
  };
  handle('project:save', (value: unknown, saveAs: boolean) => saveProject(value, !!saveAs));
  handle('project:autosave', (value: unknown) => saveProject(value, false, true));
  handle('project:recover', (value: unknown) => {
    requireProjectIdle();
    const project = checkedProject(value);
    recoveryQueue = recoveryQueue.catch(() => {}).then(() => store.recover(project));
    return recoveryQueue;
  });
  handle('project:clear-recovery', async () => {
    await recoveryQueue;
    await store.clearRecovery();
  });
  handle('build:compile', async (value: unknown) => {
    requireProjectIdle();
    const project = checkedProject(value);
    const generation = ++requestGeneration;
    await store.requireReviewedDisk(project.id);
    const assets = await store.assets(project);
    if (generation !== requestGeneration)
      return {
        projectId: project.id,
        revision: project.revision,
        status: 'cancelled',
        durationMs: 0,
        diagnostics: [],
        log: '',
      };
    const result = await compiler.compile(project, assets);
    if (result.status === 'success' && result.pdf && generation === requestGeneration) {
      const version = await workspaces.checkpoint(project, result.pdf, 'Built from source');
      result.versionId = version.id;
    }
    return result;
  });
  handle('build:cancel', () => {
    requestGeneration++;
    return compiler.cancel();
  });
  handle('project:export-pdf', async (value: unknown) => {
    requireProjectIdle();
    const project = checkedProject(value);
    await store.requireReviewedDisk(project.id);
    const pdf =
      compiler.currentPdf(project) ??
      agentCompiler.currentPdf(project) ??
      migrationCompiler.currentPdf(project);
    if (!pdf) throw new Error('Compile the current source successfully before exporting.');
    const result = await dialog.showSaveDialog(window!, {
      title: 'Export your resume',
      defaultPath: `${project.name.replace(/[^\w\s-]/g, '') || 'resume'}.pdf`,
      filters: [{ name: 'PDF document', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return false;
    await atomicWrite(result.filePath, pdf);
    return true;
  });
  handle('project:export-source', async (value: unknown) => {
    requireProjectIdle();
    const project = checkedProject(value);
    await store.requireReviewedDisk(project.id);
    const result = await dialog.showSaveDialog(window!, {
      title: 'Export LaTeX project',
      defaultPath: 'resume-source.zip',
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) return false;
    const files: Record<string, Uint8Array> = Object.fromEntries(await store.assets(project));
    for (const file of project.files) files[file.path] = strToU8(file.content);
    const exportId = randomUUID();
    files['resume.project.json'] = strToU8(
      JSON.stringify(
        {
          schemaVersion: 2,
          id: exportId,
          revision: project.revision,
          name: project.name,
          mainFile: project.mainFile,
          templateId: project.templateId,
          templateVersion: project.templateVersion,
          runtime: project.runtime,
          engine: project.runtime ? `tectonic@${project.runtime.version}` : undefined,
          bundle: project.runtime?.bundle,
        },
        null,
        2,
      ),
    );
    files['resume.folio'] = await workspaces.archive(project.id, exportId);
    files['resume.trash'] = removedFileArchive(project.removedFiles);
    await atomicWrite(result.filePath, zipSync(files));
    return true;
  });
  handle('app:external', async (value: unknown) => {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid link.');
    const url = new URL(value);
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol))
      throw new Error('This link type is not supported.');
    await shell.openExternal(url.href);
  });
  handle('app:close', async () => {
    await fonts.cancel();
    await migrations.cancel();
    await recoveryQueue;
    await agent.cancel();
    providers.close();
    await workspaces.flush();
    await compiler.cancel();
    closing = true;
    window?.close();
  });
}

function createWindow() {
  closing = false;
  window = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1040,
    minHeight: 680,
    title: 'Folio — Resume Studio',
    backgroundColor: windowBackground(),
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.once('ready-to-show', () => window?.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('close', (event) => {
    if (!closing) {
      event.preventDefault();
      window?.webContents.send('menu', 'close');
    }
  });
  window.on('closed', () => {
    watcher.stop();
    window = null;
  });
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadURL('folio://app/index.html');
}

if (primaryInstance)
  void app.whenReady().then(async () => {
    const dataRoot = app.getPath('userData');
    await fs.mkdir(dataRoot, { recursive: true });
    importer = new ProjectImporter(dataRoot);
    runtimes = new RuntimeManager(runtimeRoot, path.join(dataRoot, 'runtimes'));
    void runtimes.initialize();
    store = new ProjectStore(dataRoot, undefined, () => runtimes.defaultPin);
    watcher = new ProjectWatcher(
      (id) => store.inspectChanges(id),
      (report) => {
        if (window && !window.isDestroyed()) window.webContents.send('project:changes', report);
      },
    );
    app.on('before-quit', () => watcher.stop());
    compiler = new Compiler(runtimes, path.join(dataRoot, 'builds'));
    agentCompiler = new Compiler(runtimes, path.join(dataRoot, 'agent-builds'));
    workspaces = new WorkspaceStore(dataRoot);
    migrationCompiler = new Compiler(runtimes, path.join(dataRoot, 'migration-builds'));
    migrations = new CompilerMigration(path.join(dataRoot, 'compiler-backups'), {
      target: () => runtimes.defaultPin,
      start: async () => {
        requestGeneration++;
        await agent.cancel();
        await compiler.cancel();
        await recoveryQueue;
      },
      assets: (project) => store.assets(project),
      checkDisk: async (project) => {
        const changes = await store.inspectChanges(project.id);
        if (changes?.error || changes?.changes.length)
          throw new Error(
            'Files changed outside Folio. Review or save them before comparing compilers.',
          );
      },
      compile: (project, assets) => migrationCompiler.compile(project, assets),
      cancel: () => migrationCompiler.cancel(),
      recover: (project) => {
        recoveryQueue = recoveryQueue.catch(() => {}).then(() => store.recover(project));
        return recoveryQueue;
      },
      workspace: workspaces,
    });
    fonts = new FontImport({
      start: async () => {
        requestGeneration++;
        await agent.cancel();
        await compiler.cancel();
        await recoveryQueue;
      },
      choose: async (style) => {
        const result = await dialog.showOpenDialog(window!, {
          title: `Choose the ${style === 'boldItalic' ? 'bold italic' : style} font`,
          properties: ['openFile'],
          filters: [{ name: 'Font files', extensions: ['otf', 'ttf'] }],
        });
        return result.canceled ? undefined : result.filePaths[0];
      },
      checkDisk: async (project) => {
        if (!store.directory(project.id))
          throw new Error('Save this project before adding font files.');
        const changes = await store.inspectChanges(project.id);
        if (changes?.error || changes?.changes.length)
          throw new Error(
            'Files changed outside Folio. Close font setup and review or save those changes first.',
          );
      },
      assets: (project) => store.assets(project),
      compile: (project, assets) => migrationCompiler.compile(project, assets),
      cancel: () => migrationCompiler.cancel(),
      save: async (project, assets, build) => {
        const history = (id: string) => workspaces.archive(project.id, id);
        const saved = await store.saveWithAssets(project, assets, history);
        if (saved.conflict)
          throw new Error(
            'Files changed outside Folio. Your font setup was not saved. Close this setup and review the changes.',
          );
        const next = {
          ...project,
          directory: saved.directory,
          removedFiles: saved.removedFiles ?? project.removedFiles,
        };
        const warnings = [saved.warning];
        // The source and font files have committed together. Later history or
        // recovery errors must not pretend that the font change was rolled back.
        try {
          build.versionId = (
            await workspaces.checkpoint(next, build.pdf!, 'Changed local fonts')
          ).id;
          const archived = await store.save(next, undefined, false, history, true);
          if (archived.conflict)
            warnings.push(
              'Fonts were saved, but outside changes prevented saving the new PDF history. Review the changes, then save.',
            );
          if (archived.warning) warnings.push(archived.warning);
        } catch {
          warnings.push(
            'Fonts were saved, but the new PDF history could not be saved. Compile and save again.',
          );
        }
        recoveryQueue = recoveryQueue.catch(() => {}).then(() => store.recover(next));
        try {
          await recoveryQueue;
        } catch {
          warnings.push(
            'Fonts were saved, but draft recovery could not be updated. Reopen the saved project if needed.',
          );
        }
        void watcher.check();
        return { project: next, build, warning: warnings.filter(Boolean).join(' ') || undefined };
      },
    });
    connections = new ConnectionStore(dataRoot, {
      available: () =>
        safeStorage.isEncryptionAvailable() &&
        (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value),
    });
    providers = new ProviderService(connections, path.join(dataRoot, 'ai-requests'));
    agent = new ResumeAgent({
      workspace: workspaces,
      model: () => providers.model(),
      assets: async (project) => {
        await store.requireReviewedDisk(project.id);
        return store.assets(project);
      },
      compile: (project, assets) => agentCompiler.compile(project, assets),
      cancelBuild: () => agentCompiler.cancel(),
      render: renderPdf,
      progress: (event) => window?.webContents.send('agent:progress', event),
    });
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    protocol.handle('folio', (request) => {
      const url = new URL(request.url);
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const root = path.join(app.getAppPath(), 'dist');
      const file = path.resolve(root, relative);
      if (url.hostname !== 'app' || !file.startsWith(root + path.sep))
        return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(file).href);
    });
    registerHandlers();
    const send = (action: string) => () => window?.webContents.send('menu', action);
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === 'darwin'
          ? [
              {
                label: 'Folio',
                submenu: [
                  { role: 'about' as const },
                  { type: 'separator' as const },
                  { role: 'hide' as const },
                  { role: 'quit' as const },
                ],
              },
            ]
          : []),
        {
          label: 'File',
          submenu: [
            { label: 'New from template', accelerator: 'CmdOrCtrl+N', click: send('new') },
            { label: 'Open project…', accelerator: 'CmdOrCtrl+O', click: send('open') },
            { label: 'Open project folder…', click: send('open-folder') },
            { label: 'Import ZIP project…', click: send('import-zip') },
            { label: 'Save project', accelerator: 'CmdOrCtrl+S', click: send('save') },
            { label: 'Save project as…', accelerator: 'CmdOrCtrl+Shift+S', click: send('save-as') },
            { type: 'separator' },
            { label: 'Compile', accelerator: 'CmdOrCtrl+Enter', click: send('compile') },
            { label: 'Export PDF…', accelerator: 'CmdOrCtrl+Shift+E', click: send('export') },
            { role: 'close' },
          ],
        },
        { role: 'editMenu' },
        {
          label: 'View',
          submenu: [
            { role: 'togglefullscreen' },
            ...(!app.isPackaged ? [{ role: 'toggleDevTools' as const }] : []),
          ],
        },
      ]),
    );
    createWindow();
  });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (primaryInstance && !window) createWindow();
});
