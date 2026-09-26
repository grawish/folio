import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  ArrowDownToLine,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  History,
  ChevronRight,
  CircleHelp,
  FileCode2,
  FilePlus2,
  FileText,
  FolderOpen,
  LayoutTemplate,
  LoaderCircle,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  Save,
  Settings2,
  Square,
  Sun,
  TriangleAlert,
  X,
  MessageSquare,
  Code2,
} from 'lucide-react';
import type {
  BuildResult,
  Diagnostic,
  Project,
  RuntimeStatus,
  TemplateId,
  ProjectImportPreview,
  ProjectDiskChanges,
} from './shared/types';
import { createProject } from './shared/templates';
import type { PaperSize } from './shared/template-catalog';
import { TemplatePicker } from './components/TemplatePicker';
import { LatexEditor, type EditorHandle } from './components/LatexEditor';
import { PdfPreview, type PdfPreviewHandle } from './components/PdfPreview';
import { ActionMenu } from './components/ActionMenu';
import { ProjectFiles } from './components/ProjectFiles';
import { Modal } from './components/Modal';
import { ImportProjectDialog } from './components/ImportProjectDialog';
import { useAppearance } from './appearance';
import type {
  AISettings,
  AgentProgress,
  PdfAnnotation,
  VersionSnapshot,
  WorkspaceState,
} from './shared/ai';
import { ChatPanel } from './components/ChatPanel';
import { SettingsModal } from './components/SettingsModal';
import { InterruptedImports } from './components/InterruptedImports';
import { VersionHistory } from './components/VersionHistory';
import { CompilerComparison } from './components/CompilerComparison';
import { renderPdfFeedback } from './pdf-feedback';
import { useWorkspace } from './useWorkspace';
import { errorMessage } from './error-message';
import { addSource, renameSource, removeSource, restoreSource } from './shared/project-files';
import { FileManager } from './components/FileManager';
import { ExternalChanges } from './components/ExternalChanges';
import { PaneDivider } from './components/PaneDivider';
import { usePaneLayout } from './usePaneLayout';
import { minimumSidebar, minimumEditor } from './shared/workspace-layout';
import { buildHelp } from './shared/build-help';
import { FontSetup } from './components/FontSetup';

type Dialog =
  | 'templates'
  | 'settings'
  | 'help'
  | 'new-file'
  | 'unsaved'
  | 'recent'
  | 'snippets'
  | 'main-file'
  | 'compiler-migration'
  | 'fonts'
  | 'history'
  | 'file-manager'
  | 'removed-files'
  | 'external-changes'
  | 'interrupted-imports'
  | null;
const keyOf = (p: Project) =>
  JSON.stringify([p.name, p.mainFile, p.files, p.removedFiles ?? [], p.runtime]);
const snippets = [
  {
    name: 'Experience',
    detail: 'A role and its achievements',
    text: '\n\\section{Experience}\n\\textbf{Job title} \\hfill 2024 -- Present\\\\\n\\textit{Company name}\n\\begin{itemize}\n  \\item Describe your impact with a specific result.\n\\end{itemize}\n',
  },
  {
    name: 'Education',
    detail: 'Your degree and institution',
    text: '\n\\section{Education}\n\\textbf{Degree, Field of study} \\hfill 2020 -- 2024\\\\\nUniversity name\n',
  },
  {
    name: 'Project',
    detail: 'Something you are proud of',
    text: '\n\\section{Projects}\n\\textbf{Project name} \\hfill 2024\\\\\nDescribe what you built and why it mattered.\n',
  },
  {
    name: 'Skills',
    detail: 'Your tools and capabilities',
    text: '\n\\section{Skills}\n\\textbf{Skills} \\enspace Skill one, skill two, skill three\n',
  },
];

export default function App() {
  const { appearance, setAppearance, theme } = useAppearance();
  const [project, setProject] = useState<Project>(() => createProject());
  const current = useRef(project);
  current.current = project;
  const [activeFile, setActiveFile] = useState('main.tex');
  const [editorSession, setEditorSession] = useState(() => crypto.randomUUID());
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const defaultRuntime = useRef<Project['runtime']>(undefined);
  const [initialized, setInitialized] = useState(false);
  const [bootstrapError, setBootstrapError] = useState('');
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [savedKey, setSavedKey] = useState('');
  const [building, setBuilding] = useState(false);
  const [result, setResult] = useState<BuildResult | null>(null);
  const [lastGood, setLastGood] = useState<BuildResult | null>(null);
  const pdfPreview = useRef<PdfPreviewHandle>(null);
  const [autoCompile, setAutoCompile] = useState(
    () => localStorage.getItem('folio:auto') !== 'false',
  );
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem('folio:font')) || 14);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [pendingImport, setPendingImport] = useState<ProjectImportPreview | null>(null);
  const [interruptedImportCount, setInterruptedImportCount] = useState(0);
  const [resolvingImport, setResolvingImport] = useState(false);
  const [importRecoveryError, setImportRecoveryError] = useState('');
  const [toast, setToast] = useState('');
  const [logsOpen, setLogsOpen] = useState(false);
  const [rawLog, setRawLog] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const panes = usePaneLayout(sidebarOpen);
  const [autoSave, setAutoSave] = useState(() => localStorage.getItem('folio:autosave') === 'true');
  const [autoSaveError, setAutoSaveError] = useState('');
  const [saveActive, setSaveActive] = useState(false);
  const [savedWorkspace, setSavedWorkspace] = useState<WorkspaceState | null>(null);
  const [openingProject, setOpeningProject] = useState(false);
  const switchingProject = useRef(false);
  const closing = useRef(false);
  const [recent, setRecent] = useState<{ name: string; path: string }[]>([]);
  const [newPath, setNewPath] = useState('');
  const [newPathError, setNewPathError] = useState('');
  const [managedFile, setManagedFile] = useState('');
  const [diskChanges, setDiskChanges] = useState<ProjectDiskChanges | null>(null);
  const diskChangesRef = useRef<ProjectDiskChanges | null>(null);
  const diskGeneration = useRef(0);
  const [reloadingDisk, setReloadingDisk] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [exporting, setExporting] = useState(false);
  const editor = useRef<EditorHandle>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const buildToken = useRef(0);
  const pendingAction = useRef<(() => void) | null>(null);
  const message = useCallback((text: string) => setToast(errorMessage(text)), []);
  const [view, setView] = useState<'chat' | 'code'>('chat');
  const [connections, setConnections] = useState<AISettings>({ connections: [], activeId: null });
  const [settingsTab, setSettingsTab] = useState<'general' | 'ai' | 'about'>('general');
  const [agentProgress, setAgentProgress] = useState<AgentProgress | null>(null);
  const activeRun = useRef<{ id: string; projectId: string } | null>(null);
  const saving = useRef(false);
  const savingFinished = useRef(Promise.resolve());
  const [savingCopy, setSavingCopy] = useState(false);
  const migrationId = useRef<string | undefined>(undefined);
  const fontImport = useRef<{ id: string; started: boolean } | undefined>(undefined);
  const [historyId, setHistoryId] = useState<string>();
  const [historyNote, setHistoryNote] = useState<PdfAnnotation>();
  const [focusNoteId, setFocusNoteId] = useState<string>();
  const {
    workspace,
    workspaceRef,
    ready: workspaceReady,
    updateWorkspace,
    flushWorkspace,
    refreshVersions,
  } = useWorkspace(project.id, initialized, message);
  const agentBusy =
    !!agentProgress && !['complete', 'error', 'cancelled'].includes(agentProgress.phase);
  const projectKey = useMemo(() => keyOf(project), [project]);
  const dirty = project.revision > 0 && projectKey !== savedKey;
  const folderDirty =
    dirty || (autoSave && !!project.directory && workspaceReady && workspace !== savedWorkspace);
  const active = project.files.find((f) => f.path === activeFile) ?? project.files[0];
  const needsDiskReview =
    !!diskChanges &&
    (!!diskChanges.error || diskChanges.changes.some((file) => file.kind !== 'project'));
  const stale =
    needsDiskReview ||
    lastGood?.projectId !== project.id ||
    lastGood?.revision !== project.revision;
  const warnings = result?.diagnostics.filter((d) => d.severity === 'warning').length ?? 0;
  const errors = result?.diagnostics.filter((d) => d.severity === 'error').length ?? 0;
  const recoveryHelp = useMemo(() => buildHelp(result), [result]);
  const runtimeNotice = !initialized
    ? null
    : !window.folio
      ? 'Desktop app required'
      : !runtime?.ready
        ? 'Compiler needs attention'
        : null;

  useEffect(() => {
    tabs.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active.path, project.id]);

  useEffect(() => {
    const strip = tabs.current;
    if (!strip) return;
    const observer = new ResizeObserver(() => {
      strip
        .querySelector('[aria-current="page"]')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    observer.observe(strip);
    return () => observer.disconnect();
  }, []);

  const api = useCallback(() => {
    if (!window.folio) {
      message('Open the desktop app with npm run dev to compile, save, and export locally.');
      return null;
    }
    return window.folio;
  }, [message]);
  const loadProject = useCallback(
    (next: Project) => {
      next = { ...next, runtime: next.runtime ?? defaultRuntime.current };
      setRuntime(null);
      setAutoSaveError('');
      setSavedWorkspace(null);
      diskChangesRef.current = null;
      setDiskChanges(null);
      diskGeneration.current++;
      if (activeRun.current) {
        const run = activeRun.current;
        void window.folio?.cancelAgent(run.id);
        const previous = workspaceRef.current;
        if (previous.projectId === run.projectId) {
          const saved = {
            ...previous,
            messages: [
              ...previous.messages,
              {
                id: crypto.randomUUID(),
                role: 'assistant' as const,
                text: 'Stopped because another project was opened. Your resume is unchanged.',
                createdAt: new Date().toISOString(),
                annotationIds: [],
                runId: run.id,
                status: 'cancelled' as const,
              },
            ],
          };
          updateWorkspace(saved);
          void window.folio?.saveWorkspace(saved).catch((error) => message(error.message));
        }
      }
      activeRun.current = null;
      setAgentProgress(null);
      setView('chat');
      buildToken.current++;
      void window.folio?.cancelBuild();
      current.current = next;
      setEditorSession(crypto.randomUUID());
      setProject(next);
      setActiveFile(next.mainFile);
      setResult(null);
      setLastGood(null);
      setBuilding(false);
      setLogsOpen(false);
      setSavedKey(next.directory ? keyOf(next) : '');
    },
    [message, updateWorkspace, workspaceRef],
  );

  const receiveDiskChanges = useCallback((report: ProjectDiskChanges | null) => {
    if (report && report.projectId !== current.current.id) return;
    const next = report && (report.error || report.changes.length) ? report : null;
    if (JSON.stringify(next) === JSON.stringify(diskChangesRef.current)) return;
    diskChangesRef.current = next;
    diskGeneration.current++;
    setDiskChanges(next);
    if (!next) setDialog((previous) => (previous === 'external-changes' ? null : previous));
    if (next && (next.error || next.changes.some((file) => file.kind !== 'project'))) {
      buildToken.current++;
      void window.folio?.cancelBuild();
      setBuilding(false);
    }
  }, []);
  useEffect(() => window.folio?.onProjectChanges(receiveDiskChanges), [receiveDiskChanges]);
  useEffect(() => {
    if (!initialized || !window.folio) return;
    let alive = true;
    void window.folio
      .watchProject(project.directory ? project.id : null)
      .then((report) => {
        if (alive) receiveDiskChanges(report);
      })
      .catch((error) => {
        if (alive) message(error.message);
      });
    return () => {
      alive = false;
    };
  }, [initialized, project.id, project.directory, receiveDiskChanges, message]);
  const checkDisk = async () => {
    const id = current.current.id;
    const report = await window.folio?.checkProjectChanges(id);
    if (current.current.id === id && report !== undefined) receiveDiskChanges(report);
  };
  const requireDiskReview = () => {
    const changes = diskChangesRef.current;
    if (changes && (changes.error || changes.changes.some((file) => file.kind !== 'project'))) {
      setDialog('external-changes');
      message(
        'Review files changed outside Folio before building, sending a request or exporting.',
      );
      return true;
    }
    return false;
  };

  useEffect(() => {
    const desktop = window.folio;
    if (!desktop) return;
    void desktop
      .getAISettings()
      .then(setConnections)
      .catch((error) => message(error.message));
    const progress = desktop.onAgentProgress((event) => {
      if (event.runId === activeRun.current?.id) setAgentProgress(event);
    });
    const render = desktop.onRenderPdf((event) => {
      void renderPdfFeedback(event.pdf, event.annotations)
        .then((result) => desktop.completePdfRender(event.requestId, result))
        .catch((error) =>
          desktop.completePdfRender(event.requestId, { error: error.message }).catch(() => {}),
        );
    });
    return () => {
      progress();
      render();
    };
  }, [message]);

  useEffect(() => {
    let alive = true;
    setBootstrapError('');
    if (!window.folio) {
      setInitialized(true);
      return;
    }
    void window.folio
      .bootstrap()
      .then((data) => {
        if (!alive) return;
        defaultRuntime.current = data.runtime.defaultPin;
        setRuntime(data.runtime);
        setRecent(data.recent);
        setInterruptedImportCount(data.interruptedImportCount);
        if (data.recovered) {
          loadProject(data.recovered);
          setSavedKey('');
          message('Your last workspace has been restored.');
        } else
          setProject((project) => ({
            ...project,
            runtime: project.runtime ?? defaultRuntime.current,
          }));
        setInitialized(true);
      })
      .catch((e) => {
        if (alive) {
          setBootstrapError(errorMessage(e.message));
        }
      });
    return () => {
      alive = false;
    };
  }, [loadProject, message, bootstrapAttempt]);

  const runtimeKey = JSON.stringify(project.runtime);
  // Opening the same project resets runtime/preview state too. Its id and pin
  // do not change, so use the new editor session to re-check readiness.
  useEffect(() => {
    if (!initialized || !window.folio) return;
    let current = true;
    void window.folio
      .inspectRuntime(project.runtime)
      .then((status) => {
        if (current) setRuntime(status);
      })
      .catch((error) => {
        if (current) message(error.message);
      });
    return () => {
      current = false;
    };
  }, [initialized, project.id, editorSession, runtimeKey, message]);

  const compile = useCallback(async (): Promise<BuildResult | null> => {
    const desktop = api();
    if (!desktop || migrationId.current || fontImport.current) return null;
    if (requireDiskReview()) return null;
    const snapshot = current.current;
    const token = ++buildToken.current;
    setBuilding(true);
    try {
      const next = await desktop.compile(snapshot);
      if (token !== buildToken.current || snapshot.id !== current.current.id) return next;
      if (next.status !== 'cancelled' && next.revision === current.current.revision) {
        setResult(next);
        if (next.status === 'success') {
          setLastGood(next);
          void refreshVersions().catch((error) => message(error.message));
        }
        if (next.status === 'error') {
          if (next.runtimeUnavailable)
            setRuntime((runtime) =>
              runtime ? { ...runtime, ready: false, message: next.log } : runtime,
            );
          setLogsOpen(true);
          setView('code');
        }
      }
      return next;
    } catch (e) {
      message((e as Error).message);
      return null;
    } finally {
      if (token === buildToken.current) setBuilding(false);
    }
  }, [api, message, refreshVersions]);
  useEffect(() => {
    if (
      !initialized ||
      !runtime?.ready ||
      !autoCompile ||
      dialog === 'compiler-migration' ||
      dialog === 'fonts' ||
      agentBusy ||
      needsDiskReview ||
      reloadingDisk
    )
      return;
    // A checked agent result already has the PDF for this exact revision.
    if (lastGood?.projectId === project.id && lastGood.revision === project.revision) return;
    const timer = setTimeout(() => {
      void compile();
    }, 700);
    return () => clearTimeout(timer);
  }, [
    initialized,
    runtime?.ready,
    autoCompile,
    dialog,
    project.id,
    project.revision,
    compile,
    agentBusy,
    lastGood,
    needsDiskReview,
    reloadingDisk,
  ]);
  useEffect(() => {
    if (
      !initialized ||
      !window.folio ||
      saveActive ||
      dialog === 'compiler-migration' ||
      dialog === 'fonts'
    )
      return;
    const timer = setTimeout(() => {
      if (saving.current) return;
      void window.folio
        ?.recover(project)
        .catch((e) => message(`Recovery could not be saved: ${e.message}`));
    }, 500);
    return () => clearTimeout(timer);
  }, [project, initialized, message, saveActive, dialog]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 6500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    localStorage.setItem('folio:auto', String(autoCompile));
  }, [autoCompile]);
  useEffect(() => {
    localStorage.setItem('folio:font', String(fontSize));
  }, [fontSize]);
  useEffect(() => {
    localStorage.setItem('folio:autosave', String(autoSave));
  }, [autoSave]);

  const save = async (saveAs = false, automatic = false): Promise<boolean> => {
    const desktop = api();
    if (!desktop) return false;
    if (saving.current) {
      if (!automatic) message('A save is already in progress. Please wait for it to finish.');
      return false;
    }
    if (
      automatic &&
      (!current.current.directory ||
        activeRun.current ||
        closing.current ||
        switchingProject.current)
    )
      return false;
    if (saveAs && activeRun.current) {
      message(
        'Stop the current request before saving a separate copy. You can still save this project.',
      );
      return false;
    }
    const snapshot = current.current;
    const chatSnapshot = workspaceRef.current;
    saving.current = true;
    setSaveActive(true);
    setSavingCopy(saveAs);
    let finishSave!: () => void;
    savingFinished.current = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    try {
      await flushWorkspace();
      const saved = automatic
        ? await desktop.autosaveProject(snapshot)
        : await desktop.saveProject(snapshot, saveAs);
      if (saved.saved && snapshot.id === current.current.id) {
        // Close may be waiting for this promise. Publish the new Save As identity
        // before allowing it to flush recovery for the current project.
        flushSync(() => {
          setAutoSaveError(saved.warning ?? '');
          setSavedWorkspace(chatSnapshot);
          setSavedKey(
            keyOf({ ...snapshot, removedFiles: saved.removedFiles ?? snapshot.removedFiles }),
          );
          const previousIds = new Set(snapshot.removedFiles?.map((file) => file.id));
          const additional = (saved.removedFiles ?? []).filter((file) => !previousIds.has(file.id));
          setProject((p) => ({
            ...p,
            id: saved.projectId ?? p.id,
            directory: saved.directory,
            removedFiles: [
              ...(p.removedFiles ?? []),
              ...additional.filter((copy) => !p.removedFiles?.some((file) => file.id === copy.id)),
            ],
          }));
        });
        if (!automatic || saved.warning)
          message(saved.warning ?? 'Project saved. Your LaTeX files are ready to take anywhere.');
      } else if (automatic && snapshot.id === current.current.id) {
        setAutoSaveError(
          saved.conflict
            ? 'Files changed outside Folio. Review them, then use Save to resume autosave.'
            : (saved.warning ?? 'The project could not be saved. Use Save to retry.'),
        );
      }
      return saved.saved;
    } catch (e) {
      if (automatic && snapshot.id === current.current.id)
        setAutoSaveError(errorMessage((e as Error).message));
      message((e as Error).message);
      return false;
    } finally {
      saving.current = false;
      setSaveActive(false);
      setSavingCopy(false);
      finishSave();
      void checkDisk().catch(() => {});
    }
  };
  const autosaveAction = useRef(save);
  autosaveAction.current = save;
  useEffect(() => {
    if (
      !autoSave ||
      !initialized ||
      !window.folio ||
      !workspaceReady ||
      !project.directory ||
      saveActive ||
      savingCopy ||
      reloadingDisk ||
      pendingImport ||
      openingProject ||
      dialog ||
      agentBusy ||
      diskChanges ||
      autoSaveError ||
      (projectKey === savedKey && workspace === savedWorkspace)
    )
      return;
    const timer = setTimeout(() => {
      if (!closing.current) void autosaveAction.current(false, true);
    }, 2000);
    return () => clearTimeout(timer);
  }, [
    autoSave,
    initialized,
    workspaceReady,
    project.id,
    project.directory,
    projectKey,
    savedKey,
    workspace,
    savedWorkspace,
    saveActive,
    savingCopy,
    reloadingDisk,
    pendingImport,
    openingProject,
    dialog,
    agentBusy,
    diskChanges,
    autoSaveError,
  ]);
  const useDiskSource = async (mainFile: string) => {
    if (!window.folio || saving.current || !diskChangesRef.current) return;
    if (activeRun.current) throw new Error('Stop the current AI request before reloading source.');
    const snapshot = current.current,
      token = diskChangesRef.current.token;
    saving.current = true;
    setReloadingDisk(true);
    let finish!: () => void;
    savingFinished.current = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      const next = await window.folio.useDiskSource(snapshot, token, mainFile);
      flushSync(() => {
        current.current = next;
        setProject(next);
        if (!next.files.some((file) => file.path === activeFile)) setActiveFile(next.mainFile);
        buildToken.current++;
        void window.folio?.cancelBuild();
        setBuilding(false);
        setDialog(null);
      });
      await checkDisk();
      message('Source reloaded. Differing editor text is kept in Removed files & saved copies.');
    } finally {
      saving.current = false;
      setReloadingDisk(false);
      finish();
    }
  };
  const guard = (action: () => void) => {
    if (saving.current) {
      message('Wait for the current save to finish before switching projects.');
      return;
    }
    if (dirty) {
      pendingAction.current = action;
      setDialog('unsaved');
    } else action();
  };
  const openProject = async (path?: string, folder = false) => {
    const desktop = api();
    if (!desktop) return;
    switchingProject.current = true;
    setOpeningProject(true);
    try {
      const next = path
        ? await desktop.openRecent(path)
        : folder
          ? await desktop.openFolder()
          : await desktop.openProject();
      if (next) {
        loadProject(next);
        await desktop.recover(next);
        setRecent(await desktop.recentProjects());
        if (folder && next.files.filter((file) => file.path.endsWith('.tex')).length > 1)
          setDialog('main-file');
      }
    } catch (e) {
      message((e as Error).message);
    } finally {
      switchingProject.current = false;
      setOpeningProject(false);
    }
  };
  const prepareImport = async () => {
    switchingProject.current = true;
    setOpeningProject(true);
    try {
      const preview = await api()?.prepareImport();
      if (preview) setPendingImport(preview);
    } catch (error) {
      message((error as Error).message);
    } finally {
      switchingProject.current = false;
      setOpeningProject(false);
    }
  };
  const finishImport = async (mainFile: string) => {
    if (!pendingImport || !window.folio || saving.current) return;
    saving.current = true;
    let finish!: () => void;
    savingFinished.current = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      const next = await window.folio.finishImport(pendingImport.token, mainFile);
      if (!next) return;
      let warning = '';
      let recovered = false;
      try {
        await window.folio.recover(next);
        setRecent(await window.folio.recentProjects());
        recovered = true;
      } catch {
        warning =
          'Project imported, but local recovery could not be updated. The new project is saved in its folder.';
      }
      flushSync(() => {
        loadProject(next);
        setPendingImport(null);
      });
      if (recovered) {
        try {
          await window.folio.acknowledgeImport(pendingImport.token);
        } catch {
          warning = 'Project imported. Its recovery copy remains in Interrupted imports.';
        }
      }
      message(warning || 'Project imported into a new folder.');
    } finally {
      saving.current = false;
      finish();
      void window.folio
        .interruptedImports()
        .then((items) => setInterruptedImportCount(items.length))
        .catch((error) => message(error.message));
    }
  };
  const resolveInterruptedImport = async (id: string, action: 'resume' | 'discard' | 'forget') => {
    if (!window.folio || saving.current) return;
    setDialog('interrupted-imports');
    setResolvingImport(true);
    setImportRecoveryError('');
    saving.current = true;
    let finish!: () => void;
    savingFinished.current = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      if (action === 'resume') {
        const next = await window.folio.resumeImport(id);
        await window.folio.recover(next);
        setRecent(await window.folio.recentProjects());
        flushSync(() => {
          loadProject(next);
          setDialog(null);
        });
        try {
          await window.folio.acknowledgeImport(id);
        } catch {
          message('Project recovered. Its saved recovery copy still needs review.');
        }
      } else if (action === 'discard') await window.folio.discardImport(id);
      else await window.folio.forgetImport(id);
    } catch (error) {
      setImportRecoveryError(errorMessage((error as Error).message));
    } finally {
      saving.current = false;
      setResolvingImport(false);
      finish();
      void window.folio
        .interruptedImports()
        .then((items) => setInterruptedImportCount(items.length))
        .catch((error) => message(error.message));
    }
  };
  const exportPdf = async () => {
    if (exporting) return;
    if (requireDiskReview()) return;
    const desktop = api();
    if (!desktop) return;
    setExporting(true);
    try {
      const snapshot = current.current;
      let pdf = lastGood?.pdf;
      if (lastGood?.projectId !== snapshot.id || lastGood.revision !== snapshot.revision) {
        const built = await compile();
        if (
          built?.status !== 'success' ||
          current.current.id !== snapshot.id ||
          current.current.revision !== snapshot.revision
        ) {
          message('Export needs a successful build of your current source.');
          return;
        }
        pdf = built.pdf;
      }
      if (!pdf || !pdfPreview.current) throw new Error('Build a PDF preview before exporting.');
      await pdfPreview.current.waitForPdf(pdf);
      if (current.current.id !== snapshot.id || current.current.revision !== snapshot.revision)
        throw new Error('The resume changed while its preview was loading. Export again.');
      if (await desktop.exportPdf(snapshot))
        message('Your resume has been exported. Good luck with your next chapter.');
    } catch (e) {
      message((e as Error).message);
    } finally {
      setExporting(false);
    }
  };
  const exportSource = async () => {
    if (requireDiskReview()) return;
    try {
      await flushWorkspace();
      if (await api()?.exportSource(current.current))
        message('LaTeX project exported as a ZIP archive.');
    } catch (e) {
      message((e as Error).message);
    }
  };
  const menuAction = useRef<(action: string) => void>(() => {});
  menuAction.current = (action) => {
    if (!initialized) {
      // Recovery has not been loaded yet. Never flush the temporary starter
      // project over it when the user closes during preparation or a load error.
      if (action === 'close')
        void window.folio
          ?.closeWindow()
          .catch((error) => setBootstrapError(errorMessage(error.message)));
      return;
    }
    if (migrationId.current && action !== 'close') return;
    if (fontImport.current && action !== 'close') return;
    if (reloadingDisk && action !== 'close') return;
    if (pendingImport && action !== 'close') return;
    if (resolvingImport && action !== 'close') return;
    if (action === 'save') void save();
    else if (action === 'save-as') void save(true);
    else if (action === 'open')
      guard(() => {
        void openProject();
      });
    else if (action === 'new') setDialog('templates');
    else if (action === 'open-folder')
      guard(() => {
        void openProject(undefined, true);
      });
    else if (action === 'import-zip')
      guard(() => {
        void prepareImport();
      });
    else if (action === 'compile') void compile();
    else if (action === 'export') void exportPdf();
    else if (action === 'close')
      void (async () => {
        closing.current = true;
        try {
          await savingFinished.current;
          if (migrationId.current) await window.folio?.cancelCompilerMigration(migrationId.current);
          if (fontImport.current) await window.folio?.cancelFontImport(fontImport.current.id);
          await window.folio?.recover(current.current);
          await flushWorkspace();
          await window.folio?.closeWindow();
        } catch (e) {
          closing.current = false;
          message(`Unable to save recovery: ${(e as Error).message}`);
        }
      })();
  };
  useEffect(() => window.folio?.onMenu((action) => menuAction.current(action)), []);

  const updateSource = (content: string) =>
    setProject((p) => ({
      ...p,
      revision: p.revision + 1,
      files: p.files.map((f) => (f.path === active.path ? { ...f, content } : f)),
    }));
  const selectTemplate = (id: TemplateId, paper: PaperSize) =>
    guard(() => {
      loadProject(createProject(id, paper));
      setDialog(null);
    });
  const jump = (diagnostic: Diagnostic) => {
    setView('code');
    if (!diagnostic.line) return;
    const reported = diagnostic.file?.replaceAll('\\', '/').replace(/^\.\//, '');
    const candidates = [reported, `${reported}.tex`];
    const file = project.files.find((f) =>
      candidates.some((name) => name === f.path || name?.endsWith('/' + f.path)),
    );
    if (file) {
      setActiveFile(file.path);
      setTimeout(() => editor.current?.goToLine(diagnostic.line!), 50);
    }
  };
  const addFile = () => {
    const value = newPath.trim();
    try {
      changeFiles((p) => addSource(p, value), value);
    } catch (error) {
      setNewPathError((error as Error).message);
      return;
    }
    setView('code');
    setDialog(null);
    setNewPath('');
    message('File added. Use \\input{filename} in your main document to include it.');
  };

  const sendToAgent = async () => {
    const desktop = api();
    if (!desktop || !workspaceReady || activeRun.current) return;
    if (requireDiskReview()) return;
    if (saving.current) {
      message('Wait for the current save to finish before sending a new request.');
      return;
    }
    const state = workspaceRef.current,
      snapshot = current.current;
    if (!state.draft.trim() && !state.attachedNoteIds.length) return;
    const id = crypto.randomUUID(),
      baseKey = keyOf(snapshot),
      baseDiskGeneration = diskGeneration.current;
    activeRun.current = { id, projectId: snapshot.id };
    setAgentProgress({
      runId: id,
      projectId: snapshot.id,
      phase: 'reading',
      attempt: 0,
      message: 'Preparing your request…',
    });
    updateWorkspace((previous) => ({
      ...previous,
      draft: '',
      attachedNoteIds: [],
      messages: [
        ...previous.messages,
        {
          id: crypto.randomUUID(),
          role: 'user',
          text: state.draft.trim() || 'Please apply the attached PDF notes.',
          createdAt: new Date().toISOString(),
          annotationIds: state.attachedNoteIds,
          annotationSnapshot: state.annotations.filter((note) =>
            state.attachedNoteIds.includes(note.id),
          ),
          runId: id,
        },
      ],
    }));
    try {
      await flushWorkspace();
      const reply = await desktop.runAgent({
        runId: id,
        project: snapshot,
        message: state.draft.trim(),
        annotationIds: state.attachedNoteIds,
        pdfVersionId: lastGood?.revision === snapshot.revision ? lastGood.versionId : undefined,
      });
      if (current.current.id !== snapshot.id || activeRun.current?.id !== id) return;
      // A file notification may still be in its debounce window. Reconcile the
      // folder before applying a completed draft, even without a visible notice.
      if (reply.status === 'complete') await checkDisk();
      if (current.current.id !== snapshot.id || activeRun.current?.id !== id) return;
      let text = reply.message;
      const apply =
        reply.status === 'complete' &&
        reply.project &&
        reply.build &&
        keyOf(current.current) === baseKey &&
        diskGeneration.current === baseDiskGeneration;
      if (apply && reply.project && reply.build) {
        const next = { ...reply.project, directory: current.current.directory };
        buildToken.current++;
        current.current = next;
        setProject(next);
        setResult(reply.build);
        setLastGood(reply.build);
        setBuilding(false);
        setLogsOpen(false);
      } else if (reply.status === 'complete')
        text =
          'The checked draft is saved in History. Your project changed while I was working, so I kept your newer edits. Open History to compare or restore the draft.';
      updateWorkspace((previous) => ({
        ...previous,
        messages: [
          ...previous.messages,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            text,
            createdAt: new Date().toISOString(),
            annotationIds: [],
            versionId: reply.version?.id,
            runId: id,
            status:
              reply.status === 'error'
                ? 'error'
                : reply.status === 'cancelled'
                  ? 'cancelled'
                  : 'complete',
          },
        ],
      }));
      await flushWorkspace();
      await refreshVersions();
      setAgentProgress({
        runId: id,
        projectId: snapshot.id,
        phase:
          reply.status === 'error'
            ? 'error'
            : reply.status === 'cancelled'
              ? 'cancelled'
              : 'complete',
        message: text,
        attempt: 0,
      });
    } catch (error) {
      if (current.current.id === snapshot.id && activeRun.current?.id === id) {
        const text = (error as Error).message;
        updateWorkspace((previous) => ({
          ...previous,
          messages: [
            ...previous.messages,
            {
              id: crypto.randomUUID(),
              role: 'assistant',
              text,
              createdAt: new Date().toISOString(),
              annotationIds: [],
              runId: id,
              status: 'error',
            },
          ],
        }));
        setAgentProgress({
          runId: id,
          projectId: snapshot.id,
          phase: 'error',
          message: text,
          attempt: 0,
        });
      }
    } finally {
      if (activeRun.current?.id === id) activeRun.current = null;
    }
  };
  const restoreVersion = (snapshot: VersionSnapshot) => {
    if (agentBusy) {
      message('Stop the current request before restoring a version.');
      return;
    }
    guard(() => {
      const previous = current.current;
      const next = {
        ...previous,
        files: snapshot.files,
        mainFile: snapshot.mainFile,
        templateId: snapshot.templateId,
        templateVersion: snapshot.templateVersion,
        runtime: snapshot.runtime ?? previous.runtime,
        revision: previous.revision + 1,
      };
      buildToken.current++;
      void window.folio?.cancelBuild();
      current.current = next;
      setProject(next);
      setActiveFile(next.mainFile);
      setLastGood({
        projectId: next.id,
        revision: -1,
        status: 'success',
        pdf: snapshot.pdf,
        versionId: snapshot.info.id,
        durationMs: 0,
        diagnostics: [],
        log: '',
      });
      setResult(null);
      setDialog(null);
      setBuilding(false);
      setView('chat');
      updateWorkspace((state) => ({
        ...state,
        messages: [
          ...state.messages,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            text: `Restored “${snapshot.info.label}”. Earlier versions remain in History. Build the PDF to check it with the current project assets.`,
            createdAt: new Date().toISOString(),
            annotationIds: [],
          },
        ],
      }));
    });
  };
  const undoVersion = async (id: string) => {
    const index = workspace.versions.findIndex((version) => version.id === id);
    if (index < 1) {
      message('There is no earlier version to restore.');
      return;
    }
    try {
      const snapshot = await window.folio?.readVersion(
        project.id,
        workspace.versions[index - 1].id,
      );
      if (snapshot) restoreVersion(snapshot);
    } catch (error) {
      message((error as Error).message);
    }
  };
  const showNote = (note: PdfAnnotation) => {
    if (
      note.versionId === lastGood?.versionId &&
      workspace.annotations.some(
        (currentNote) => JSON.stringify(currentNote) === JSON.stringify(note),
      )
    ) {
      setFocusNoteId(undefined);
      requestAnimationFrame(() => setFocusNoteId(note.id));
    } else {
      setHistoryNote(note);
      setHistoryId(note.versionId);
      setDialog('history');
    }
  };

  const mainDocument = (id: string) => (
    <div className="main-file-setting">
      <label htmlFor={id}>
        Main<span className="sr-only"> document</span>
      </label>
      <select
        id={id}
        aria-label="Main document"
        value={project.mainFile}
        onChange={(e) =>
          setProject((p) => ({ ...p, mainFile: e.target.value, revision: p.revision + 1 }))
        }
      >
        {project.files
          .filter((f) => f.path.endsWith('.tex'))
          .map((f) => (
            <option key={f.path}>{f.path}</option>
          ))}
      </select>
    </div>
  );
  const newFile = () => {
    setNewPathError('');
    setDialog('new-file');
  };
  const manageFile = (name: string) => {
    if (saving.current) {
      message('Wait for the save to finish before changing files.');
      return;
    }
    setManagedFile(name);
    setDialog('file-manager');
  };
  const changeFiles = (operation: (project: Project) => Project, nextActive?: string) => {
    if (saving.current) throw new Error('Wait for the save to finish before changing files.');
    const next = operation(current.current);
    current.current = next;
    setProject(next);
    if (nextActive) setActiveFile(nextActive);
    else if (!next.files.some((file) => file.path === activeFile)) setActiveFile(next.mainFile);
  };

  const openFonts = () => {
    if (
      !window.folio ||
      saving.current ||
      agentBusy ||
      !workspaceReady ||
      needsDiskReview ||
      !runtime?.ready
    ) {
      message('Finish the current work and review any outside changes before adding fonts.');
      return;
    }
    fontImport.current = { id: crypto.randomUUID(), started: false };
    setDialog('fonts');
  };
  const beginFonts = async () => {
    const session = fontImport.current;
    if (!session) throw new Error('Open a new font setup.');
    if (!session.started) {
      buildToken.current++;
      setBuilding(false);
      await flushWorkspace();
      if (fontImport.current !== session) throw new Error('Font setup was closed.');
      await window.folio!.recover(current.current);
      if (fontImport.current !== session) throw new Error('Font setup was closed.');
      await window.folio!.beginFontImport(session.id, current.current);
      if (fontImport.current !== session) {
        await window.folio!.cancelFontImport(session.id);
        throw new Error('Font setup was closed.');
      }
      session.started = true;
    }
    return session.id;
  };
  const open = () =>
    guard(() => {
      void openProject();
    });

  return (
    <>
      <div
        className="app-shell"
        inert={!initialized || savingCopy || reloadingDisk}
        aria-busy={!initialized || savingCopy || reloadingDisk}
      >
        <header className="app-header">
          <div className="brand">
            folio<span className="brand-period">.</span>
          </div>
          <div className="project-title">
            <input
              aria-label="Project name"
              title={project.name}
              value={project.name}
              maxLength={80}
              onChange={(e) =>
                setProject((p) => ({ ...p, name: e.target.value, revision: p.revision + 1 }))
              }
            />
            <span className={`save-indicator ${folderDirty ? 'dirty' : ''}`}>
              {saveActive ? (
                'Saving…'
              ) : autoSave && (autoSaveError || diskChanges) ? (
                'Autosave paused'
              ) : folderDirty ? (
                <>
                  <span /> Unsaved changes
                </>
              ) : project.directory ? (
                <>
                  <Check size={12} /> Saved locally
                </>
              ) : (
                <>
                  <span /> Local draft
                </>
              )}
            </span>
          </div>
          <ActionMenu
            actions={[
              { label: 'Open project…', action: open },
              {
                label: 'Open project folder…',
                action: () =>
                  guard(() => {
                    void openProject(undefined, true);
                  }),
              },
              {
                label: 'Import ZIP project…',
                action: () =>
                  guard(() => {
                    void prepareImport();
                  }),
              },
              { label: 'Recent projects', action: () => setDialog('recent') },
              {
                label: 'Interrupted imports…',
                action: () => {
                  setImportRecoveryError('');
                  setDialog('interrupted-imports');
                },
              },
              { label: 'Explore templates', action: () => setDialog('templates') },
              { label: 'Add source file', action: newFile },
              { label: 'Add local fonts…', action: openFonts },
              { label: 'Rename or remove current file…', action: () => manageFile(active.path) },
              { label: 'Removed files & saved copies…', action: () => setDialog('removed-files') },
              { label: 'Insert a section', action: () => setDialog('snippets') },
              { label: 'Main document…', action: () => setDialog('main-file') },
              {
                label: 'Save project as…',
                separator: true,
                action: () => {
                  void save(true);
                },
              },
              {
                label: 'Export LaTeX source…',
                action: () => {
                  void exportSource();
                },
              },
              {
                label: 'Help and keyboard shortcuts',
                separator: true,
                action: () => setDialog('help'),
              },
              { label: 'Settings', action: () => setDialog('settings') },
            ]}
          />
          <div className="header-actions">
            {interruptedImportCount > 0 && (
              <button
                className="runtime-alert"
                aria-label="Review interrupted imports"
                title="Review interrupted imports"
                onClick={() => {
                  setImportRecoveryError('');
                  setDialog('interrupted-imports');
                }}
              >
                <TriangleAlert size={14} />
                <span>
                  {interruptedImportCount} interrupted{' '}
                  {interruptedImportCount === 1 ? 'import' : 'imports'}
                </span>
              </button>
            )}
            {runtimeNotice && (
              <button
                className="runtime-alert"
                title={runtimeNotice}
                aria-label={runtimeNotice}
                onClick={() => {
                  setSettingsTab('about');
                  setDialog('settings');
                }}
              >
                <TriangleAlert size={14} />
                <span>{runtimeNotice}</span>
              </button>
            )}
            <button
              className="icon-button header-help"
              aria-label="Help and keyboard shortcuts"
              title="Help and keyboard shortcuts"
              onClick={() => setDialog('help')}
            >
              <CircleHelp size={18} />
            </button>
            <button
              className="icon-button"
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              onClick={() => setAppearance(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button
              className="icon-button"
              aria-label="Settings"
              title="Settings"
              onClick={() => setDialog('settings')}
            >
              <Settings2 size={18} />
            </button>
            <button
              className="button secondary"
              aria-label="Save project"
              title="Save project (Cmd/Ctrl+S)"
              onClick={() => {
                void save();
              }}
            >
              <Save size={15} />
              <span>Save</span>
            </button>
            <button
              className="button primary"
              disabled={exporting || !runtime?.ready}
              onClick={() => {
                void exportPdf();
              }}
            >
              {exporting ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <ArrowDownToLine size={15} />
              )}{' '}
              Export PDF
            </button>
          </div>
        </header>
        {diskChanges && (
          <div
            className="external-change-notice"
            role="region"
            aria-label="External file changes"
            aria-live="polite"
          >
            <TriangleAlert size={14} />
            <span>
              {diskChanges.error
                ? 'Project folder needs attention.'
                : `${diskChanges.changes.length} ${diskChanges.changes.length === 1 ? 'file changed' : 'files changed'} outside Folio.`}{' '}
              Your editor text is kept.
            </span>
            <button className="text-button" onClick={() => setDialog('external-changes')}>
              Review changes
            </button>
          </div>
        )}
        {autoSave && autoSaveError && !diskChanges && (
          <div className="external-change-notice" role="status">
            <TriangleAlert size={14} />
            <span>Autosave paused. {autoSaveError}</span>
            <button className="text-button" onClick={() => void save()}>
              Save to retry
            </button>
          </div>
        )}
        <main
          ref={panes.element}
          style={panes.style}
          className={`workspace ${sidebarOpen ? '' : 'sidebar-hidden'}`}
        >
          {sidebarOpen && (
            <aside className="sidebar" id="files-pane" key="sidebar">
              <div className="sidebar-top">
                <span className="eyebrow">FILES</span>
                <div className="sidebar-tools">
                  <button
                    className="icon-button"
                    aria-label="Open project"
                    title="Open project (Cmd/Ctrl+O)"
                    onClick={open}
                  >
                    <FolderOpen size={16} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Add source file"
                    title="Add source file"
                    onClick={newFile}
                  >
                    <FilePlus2 size={16} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Hide sidebar"
                    title="Hide sidebar"
                    onClick={() => setSidebarOpen(false)}
                  >
                    <PanelLeftClose size={16} />
                  </button>
                </div>
              </div>
              <div className="project-files">
                <div className="file-tree-heading" title={project.name}>
                  <FolderOpen size={15} />
                  <span>{project.name || 'Untitled resume'}</span>
                </div>
                <ProjectFiles
                  key={project.id}
                  files={project.files}
                  active={active.path}
                  main={project.mainFile}
                  onSelect={(file) => {
                    setActiveFile(file);
                    setView('code');
                  }}
                  onManage={manageFile}
                />
              </div>
              <div className="sidebar-bottom">
                <button className="sidebar-action" onClick={() => setDialog('recent')}>
                  <History size={16} />
                  Recent projects
                  <ChevronRight size={13} />
                </button>
                <button
                  className="sidebar-action"
                  aria-label="Explore templates"
                  onClick={() => setDialog('templates')}
                >
                  <LayoutTemplate size={16} />
                  Templates
                  <ChevronRight size={13} />
                </button>
                <button className="sidebar-action" onClick={() => setDialog('snippets')}>
                  <Plus size={16} />
                  Insert a section
                  <ChevronRight size={13} />
                </button>
                {mainDocument('main-file')}
              </div>
            </aside>
          )}
          {sidebarOpen && (
            <PaneDivider
              key="files-divider"
              label="Resize file sidebar"
              controls="files-pane"
              value={panes.layout.sidebar}
              min={minimumSidebar}
              max={panes.layout.sidebarMax}
              onChange={panes.resizeSidebar}
              onReset={panes.resetSidebar}
            />
          )}
          <section
            className="editor-pane"
            id="writing-pane"
            aria-label="Resume workspace"
            key="editor"
          >
            <div className="workspace-tabs" role="tablist" aria-label="Workspace view">
              {!sidebarOpen && (
                <button
                  className="icon-button"
                  aria-label="Show sidebar"
                  onClick={() => setSidebarOpen(true)}
                >
                  <PanelLeftOpen size={16} />
                </button>
              )}
              <button role="tab" aria-selected={view === 'chat'} onClick={() => setView('chat')}>
                <MessageSquare size={16} />
                Chat
              </button>
              <button role="tab" aria-selected={view === 'code'} onClick={() => setView('code')}>
                <Code2 size={16} />
                Code
              </button>
              <button
                className="history-button"
                role="button"
                onClick={() => {
                  setHistoryId(undefined);
                  setHistoryNote(undefined);
                  setDialog('history');
                }}
              >
                <History size={15} />
                History
              </button>
            </div>
            {view === 'chat' && (
              <ChatPanel
                workspace={workspace}
                update={updateWorkspace}
                ready={workspaceReady}
                progress={agentProgress}
                connected={!!connections.activeId}
                onSend={() => void sendToAgent()}
                onStop={() => {
                  if (activeRun.current)
                    void window.folio
                      ?.cancelAgent(activeRun.current.id)
                      .catch((error) => message(error.message));
                }}
                onSettings={() => {
                  setSettingsTab('ai');
                  setDialog('settings');
                }}
                onTemplates={() => setDialog('templates')}
                onHistory={(id) => {
                  const index = workspace.versions.findIndex((v) => v.id === id);
                  setHistoryId(index > 0 ? workspace.versions[index - 1].id : id);
                  setHistoryNote(undefined);
                  setDialog('history');
                }}
                onUndo={(id) => void undoVersion(id)}
                onNote={showNote}
              />
            )}
            <div className="code-view" hidden={view !== 'code'}>
              <div className="editor-toolbar">
                <div className="editor-tabs" ref={tabs} aria-label="Source files">
                  {project.files.map((file) => (
                    <button
                      className={`editor-tab ${file.path === active.path ? 'active' : ''}`}
                      key={file.path}
                      aria-current={file.path === active.path ? 'page' : undefined}
                      title={file.path}
                      onClick={() => setActiveFile(file.path)}
                    >
                      <FileCode2 size={14} />
                      {file.path.split('/').pop()}
                      {dirty && file.path === active.path && <span className="tab-dot" />}
                    </button>
                  ))}
                </div>
                <div className="editor-tools">
                  <label className="auto-label" title="Automatic compilation">
                    <span>Auto-compile</span>
                    <input
                      type="checkbox"
                      aria-label="Auto-compile"
                      checked={autoCompile}
                      onChange={(e) => setAutoCompile(e.target.checked)}
                    />
                    <span className="toggle" />
                  </label>
                  <button
                    className={`compile-button ${building ? 'is-building' : ''}`}
                    disabled={!runtime?.ready}
                    onClick={() => {
                      if (building) {
                        buildToken.current++;
                        void window.folio?.cancelBuild();
                        setBuilding(false);
                      } else void compile();
                    }}
                  >
                    {building ? (
                      <Square size={11} fill="currentColor" />
                    ) : (
                      <Play size={11} fill="currentColor" />
                    )}
                    {building ? 'Stop' : 'Compile'}
                  </button>
                </div>
              </div>
              <LatexEditor
                ref={editor}
                value={active.content}
                filename={active.path}
                sessionId={editorSession}
                filenames={project.files.map((file) => file.path)}
                onChange={updateSource}
                onCursor={(line, column) => setCursor({ line, column })}
                fontSize={fontSize}
                dark={theme === 'dark'}
              />
              {logsOpen && (
                <div className="diagnostics-panel">
                  <div className="diagnostics-heading">
                    <strong>Build output</strong>
                    <button
                      className={`text-button ${!rawLog ? 'active' : ''}`}
                      onClick={() => setRawLog(false)}
                    >
                      Diagnostics
                    </button>
                    <button
                      className={`text-button ${rawLog ? 'active' : ''}`}
                      onClick={() => setRawLog(true)}
                    >
                      Raw log
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Close build output"
                      onClick={() => setLogsOpen(false)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                  {rawLog ? (
                    <pre>{result?.log || 'Compile your document to see its build log.'}</pre>
                  ) : (
                    <div className="diagnostic-list">
                      {recoveryHelp && (
                        <aside className="build-help" aria-labelledby="build-help-title">
                          <strong id="build-help-title">{recoveryHelp.title}</strong>
                          <ul>
                            {recoveryHelp.steps.map((step) => (
                              <li key={step}>{step}</li>
                            ))}
                          </ul>
                          {recoveryHelp.kind === 'font' && (
                            <button className="text-button active" onClick={openFonts}>
                              Add local fonts…
                            </button>
                          )}
                        </aside>
                      )}
                      {!result?.diagnostics.length ? (
                        <div className="diagnostic-empty">
                          <CheckCircle2 size={15} />
                          {result?.status === 'success'
                            ? 'All clear. Your document compiled successfully.'
                            : 'No diagnostics yet.'}
                        </div>
                      ) : (
                        result.diagnostics.map((d, i) => (
                          <button
                            key={i}
                            className={`diagnostic ${d.severity}`}
                            onClick={() => jump(d)}
                          >
                            <TriangleAlert size={14} />
                            <span>
                              {d.file && (
                                <strong>
                                  {d.file}
                                  {d.line ? `:${d.line}` : ''} —{' '}
                                </strong>
                              )}
                              {d.message}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
          <PaneDivider
            key="preview-divider"
            label="Resize writing and PDF panes"
            controls="writing-pane"
            value={panes.layout.editor}
            min={minimumEditor}
            max={panes.layout.editorMax}
            onChange={panes.resizeEditor}
            onReset={panes.resetEditor}
          />
          <section className="preview-pane" aria-label="PDF preview" key="preview">
            <PdfPreview
              ref={pdfPreview}
              data={lastGood?.pdf}
              building={building}
              stale={stale}
              versionId={lastGood?.versionId}
              annotations={workspace.annotations}
              onAnnotations={
                workspaceReady
                  ? (notes) =>
                      updateWorkspace((previous) => ({
                        ...previous,
                        annotations: notes,
                        attachedNoteIds: previous.attachedNoteIds.filter((id) =>
                          notes.some((note) => note.id === id),
                        ),
                      }))
                  : undefined
              }
              onAttach={(ids) => {
                updateWorkspace((previous) => ({
                  ...previous,
                  attachedNoteIds: [...new Set([...previous.attachedNoteIds, ...ids])],
                }));
                setView('chat');
              }}
              focusNoteId={focusNoteId}
              status={
                <span
                  className={`preview-state ${building ? 'working' : errors ? 'failed' : lastGood && !stale ? 'success' : ''}`}
                >
                  {building ? (
                    <>
                      <LoaderCircle size={12} className="spin" /> Typesetting
                    </>
                  ) : lastGood && !stale ? (
                    <>
                      <span /> Up to date
                    </>
                  ) : errors ? (
                    <>
                      <TriangleAlert size={12} /> Build needs attention
                    </>
                  ) : (
                    <>
                      <span /> Awaiting compile
                    </>
                  )}
                </span>
              }
            />
          </section>
        </main>
        <footer className="editor-status app-status">
          <button
            aria-label={`${errors} errors · ${warnings} warnings`}
            aria-expanded={logsOpen}
            title="Show or hide build output"
            onClick={() => {
              setView('code');
              setLogsOpen((v) => !v);
            }}
            className={errors ? 'error-text' : ''}
          >
            <TriangleAlert size={12} /> {errors} errors <span>·</span> {warnings} warnings
            {logsOpen ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>
          <span>
            {view === 'code' ? (
              <>
                Ln {cursor.line}, Col {cursor.column}
                <span className="status-separator">UTF-8</span>
              </>
            ) : agentBusy ? (
              'Working on your changes…'
            ) : project.directory ? (
              dirty ? (
                'Unsaved source changes'
              ) : (
                'Saved on this computer'
              )
            ) : (
              'Local workspace'
            )}
          </span>
        </footer>
        {toast && !savingCopy && (
          <div className="toast" role="status">
            <span>{toast}</span>
            <button
              className="icon-button"
              aria-label="Dismiss notification"
              onClick={() => setToast('')}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {pendingImport && (
          <ImportProjectDialog
            preview={pendingImport}
            onImport={finishImport}
            onClose={() => {
              void window.folio
                ?.cancelImport(pendingImport.token)
                .catch((error) => message(error.message));
              setPendingImport(null);
            }}
          />
        )}
        {(dialog === 'file-manager' || dialog === 'removed-files') && (
          <FileManager
            key={`${dialog}/${managedFile}`}
            project={project}
            target={dialog === 'file-manager' ? managedFile : undefined}
            onClose={() => setDialog(null)}
            onRename={(name) => {
              changeFiles(
                (p) => renameSource(p, managedFile, name),
                activeFile === managedFile ? name : undefined,
              );
              editor.current?.renameFile(managedFile, name);
              setDialog(null);
              message('File renamed. Save to update the project folder.');
            }}
            onRemove={(replacement) => {
              changeFiles((p) => removeSource(p, managedFile, replacement));
              setDialog(null);
              message('File moved to Removed files. Save to update the project folder.');
            }}
            onRestore={(id, name) => {
              changeFiles((p) => restoreSource(p, id, name), name);
              setDialog(null);
              setView('code');
              message('File restored. Save to keep it in the project folder.');
            }}
            onDiscard={(id) =>
              changeFiles((p) => ({
                ...p,
                revision: p.revision + 1,
                removedFiles: p.removedFiles?.filter((file) => file.id !== id),
              }))
            }
          />
        )}
        {dialog === 'external-changes' && diskChanges && (
          <ExternalChanges
            project={project}
            report={diskChanges}
            busy={reloadingDisk}
            onCheck={checkDisk}
            onUseDisk={useDiskSource}
            onClose={() => setDialog(null)}
            onCopy={() => {
              setDialog(null);
              void save(true);
            }}
          />
        )}
        {dialog === 'fonts' && fontImport.current && (
          <FontSetup
            saved={!!project.directory}
            onSaveProject={() => save()}
            onChoose={async (style) => window.folio!.chooseFont(await beginFonts(), style)}
            onRemove={async (style) => window.folio!.removeFont(await beginFonts(), style)}
            onPreview={async (target) =>
              window.folio!.previewFonts(await beginFonts(), current.current, target)
            }
            onApply={async () => {
              saving.current = true;
              setSaveActive(true);
              let finish = () => {};
              savingFinished.current = new Promise<void>((resolve) => {
                finish = resolve;
              });
              try {
                const reply = await window.folio!.applyFonts(
                  fontImport.current!.id,
                  current.current,
                );
                const next = reply.project;
                flushSync(() => {
                  current.current = next;
                  setProject(next);
                  setSavedKey(keyOf(next));
                  setResult(reply.build);
                  setLastGood(reply.build);
                  setAutoSaveError(reply.warning ?? '');
                  fontImport.current = undefined;
                  setDialog(null);
                });
                let warning = reply.warning;
                try {
                  await refreshVersions();
                  setSavedWorkspace(workspaceRef.current);
                  await checkDisk();
                } catch {
                  warning = [
                    warning,
                    'Fonts were saved, but the workspace could not refresh. Reopen the saved project if needed.',
                  ]
                    .filter(Boolean)
                    .join(' ');
                  setAutoSaveError(warning);
                }
                message(warning ?? 'Font files and source saved. Review the PDF before exporting.');
              } finally {
                saving.current = false;
                setSaveActive(false);
                finish();
              }
            }}
            onClose={() => {
              const id = fontImport.current?.id;
              fontImport.current = undefined;
              setDialog(null);
              void window.folio!.cancelFontImport(id).catch((error) => message(error.message));
            }}
          />
        )}
        {dialog === 'recent' && (
          <Modal title="Recent projects" onClose={() => setDialog(null)}>
            <div className="choice-list">
              {recent.length ? (
                recent.map((item) => (
                  <button
                    key={item.path}
                    title={item.path}
                    onClick={() => {
                      setDialog(null);
                      guard(() => {
                        void openProject(item.path);
                      });
                    }}
                  >
                    <FileText size={17} />
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.path}</small>
                    </span>
                    <ChevronRight size={15} />
                  </button>
                ))
              ) : (
                <p>No recent projects yet. Open a project to add it here.</p>
              )}
            </div>
          </Modal>
        )}
        {dialog === 'snippets' && (
          <Modal
            title="Insert a section"
            description="Add a section at your cursor, before the end of your document."
            onClose={() => setDialog(null)}
          >
            <div className="choice-list">
              {snippets.map((snippet) => (
                <button
                  key={snippet.name}
                  onClick={() => {
                    setDialog(null);
                    setView('code');
                    requestAnimationFrame(() => {
                      editor.current?.insert(snippet.text);
                      message('Section inserted at your cursor.');
                    });
                  }}
                >
                  <Plus size={17} />
                  <span>
                    <strong>{snippet.name}</strong>
                    <small>{snippet.detail}</small>
                  </span>
                </button>
              ))}
            </div>
          </Modal>
        )}
        {dialog === 'main-file' && (
          <Modal
            title="Choose main document"
            description="This file is compiled, regardless of which source file you are editing."
            onClose={() => setDialog(null)}
          >
            {mainDocument('dialog-main-file')}
          </Modal>
        )}
        {dialog === 'templates' && (
          <TemplatePicker onSelect={selectTemplate} onClose={() => setDialog(null)} />
        )}
        {dialog === 'settings' && (
          <SettingsModal
            appearance={appearance}
            setAppearance={setAppearance}
            autoSave={autoSave}
            setAutoSave={(enabled) => {
              setAutoSave(enabled);
              setAutoSaveError('');
            }}
            onResetPanes={panes.reset}
            onInterruptedImports={() => {
              setImportRecoveryError('');
              setDialog('interrupted-imports');
            }}
            autoCompile={autoCompile}
            setAutoCompile={setAutoCompile}
            fontSize={fontSize}
            setFontSize={setFontSize}
            runtime={runtime}
            projectId={project.id}
            onCompareCompiler={() => {
              if (saving.current || agentBusy || !workspaceReady || needsDiskReview) {
                message(
                  'Finish saving or the AI request, and review outside changes before comparing compilers.',
                );
                return;
              }
              migrationId.current = crypto.randomUUID();
              setDialog('compiler-migration');
            }}
            onRepairRuntime={async () => {
              const desktop = api();
              if (!desktop) return;
              const snapshot = current.current;
              const status = await desktop.repairRuntime(snapshot.runtime);
              if (current.current.id === snapshot.id) setRuntime(status);
              if (!status.ready) throw new Error(status.message);
              message('The recorded compiler was repaired and passed its offline check.');
            }}
            connections={connections}
            onConnections={setConnections}
            initialTab={settingsTab}
            onClose={() => {
              setDialog(null);
              setSettingsTab('general');
            }}
          />
        )}
        {dialog === 'interrupted-imports' && (
          <InterruptedImports
            busy={resolvingImport}
            error={importRecoveryError}
            onCount={setInterruptedImportCount}
            onClose={() => {
              if (!resolvingImport) setDialog(null);
            }}
            onResume={(id) =>
              guard(() => {
                void resolveInterruptedImport(id, 'resume');
              })
            }
            onDiscard={(id) => {
              void resolveInterruptedImport(id, 'discard');
            }}
            onForget={(id) => {
              void resolveInterruptedImport(id, 'forget');
            }}
          />
        )}
        {dialog === 'compiler-migration' && migrationId.current && (
          <CompilerComparison
            from={project.runtime}
            to={runtime?.defaultPin}
            onPrepare={async () => {
              const desktop = window.folio!;
              buildToken.current++;
              setBuilding(false);
              await flushWorkspace();
              await desktop.recover(current.current);
              return desktop.prepareCompilerMigration(migrationId.current!, current.current);
            }}
            onApply={async (comparison) => {
              saving.current = true;
              setSaveActive(true);
              let finish = () => {};
              savingFinished.current = new Promise<void>((resolve) => {
                finish = resolve;
              });
              try {
                const reply = await window.folio!.applyCompilerMigration(
                  comparison.id,
                  current.current,
                );
                const next = { ...reply.project, directory: current.current.directory };
                current.current = next;
                setProject(next);
                setResult(reply.build);
                setLastGood(reply.build);
                migrationId.current = undefined;
                setDialog(null);
                setAutoSaveError('');
                void window
                  .folio!.inspectRuntime(next.runtime)
                  .then(setRuntime)
                  .catch((error) => message(error.message));
                void refreshVersions().catch((error) => message(error.message));
                message(
                  reply.warning ||
                    'Compiler changed. Your backup is in Settings → About. Save to update the project folder.',
                );
              } finally {
                saving.current = false;
                setSaveActive(false);
                finish();
              }
            }}
            onShowBackup={(id) => window.folio!.showCompilerBackup(project.id, id)}
            onClose={() => {
              void window
                .folio!.cancelCompilerMigration(migrationId.current)
                .then(() => {
                  migrationId.current = undefined;
                  setSettingsTab('about');
                  setDialog('settings');
                })
                .catch((error) => message(error.message));
            }}
          />
        )}
        {dialog === 'history' && (
          <VersionHistory
            projectId={project.id}
            versions={workspace.versions}
            annotations={[
              ...new Map(
                [
                  ...workspace.messages.flatMap((m) => m.annotationSnapshot ?? []),
                  ...workspace.annotations,
                  ...(historyNote ? [historyNote] : []),
                ].map((note) => [note.id, note]),
              ).values(),
            ]}
            currentId={lastGood?.versionId}
            initialId={historyId}
            onRestore={restoreVersion}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog === 'help' && (
          <Modal title="A little help along the way." onClose={() => setDialog(null)}>
            <div className="help-body">
              <p>
                Use Chat to describe a change. Mark an area of the PDF, add a note, and attach it to
                your message. The agent edits the source, builds a PDF, and checks the finished
                pages. Use History to compare or restore versions. Choose your AI connection and
                model in Settings. Open Code whenever you want to edit TeX directly.
              </p>
              <div className="help-example">
                <code>{'\\section{Experience}'}</code>
                <span>Creates a section heading</span>
                <code>{'\\textbf{Your role}'}</code>
                <span>Makes text bold</span>
                <code>{'28\\%'}</code>
                <span>Prints a percent sign</span>
                <code>{'\\input{sections/education}'}</code>
                <span>Includes another project file</span>
              </div>
              <p>
                Keep new sections before <code>{'\\end{document}'}</code>. If the build fails, open
                its diagnostics below the source. Your last successful PDF stays visible.
              </p>
              <p>
                Templates lets you choose A4 or US Letter before creating a resume. For an existing
                bundled template, change <code>a4paper</code> to <code>letterpaper</code> (or back)
                in the first <code>{'\\documentclass'}</code> line in Code. Build and review every
                page after changing the size. The listed template fonts are included with Folio.
              </p>
              <div className="shortcut-list">
                {[
                  ['Save project', '⌘ / Ctrl S'],
                  ['Open project', '⌘ / Ctrl O'],
                  ['Compile', '⌘ / Ctrl Enter'],
                  ['Export PDF', '⌘ / Ctrl ⇧ E'],
                  ['Find in source', '⌘ / Ctrl F'],
                ].map(([a, b]) => (
                  <div key={a}>
                    <span>{a}</span>
                    <kbd>{b}</kbd>
                  </div>
                ))}
              </div>
              <p className="modal-footnote">
                Recovery snapshots stay on your device. Save your project to keep ordinary LaTeX
                files you can open in other editors.
              </p>
            </div>
          </Modal>
        )}
        {dialog === 'new-file' && (
          <Modal
            title="A little room to grow."
            description="Add a source file to organize your resume."
            onClose={() => setDialog(null)}
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                addFile();
              }}
            >
              <label className="field-label" htmlFor="new-file">
                Filename
              </label>
              <input
                autoFocus
                id="new-file"
                className="text-input"
                placeholder="sections/experience.tex"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
              />
              {newPathError && <p className="error-text">{newPathError}</p>}
              <div className="modal-actions">
                <button type="button" className="button secondary" onClick={() => setDialog(null)}>
                  Cancel
                </button>
                <button className="button primary" type="submit">
                  <FilePlus2 size={15} /> Add file
                </button>
              </div>
            </form>
          </Modal>
        )}
        {dialog === 'unsaved' && (
          <Modal
            title="Keep your latest changes?"
            description="Save this project before opening another, or discard the current changes."
            onClose={() => {
              pendingAction.current = null;
              setDialog(null);
            }}
          >
            <div className="unsaved-actions">
              <button
                className="button secondary"
                onClick={() => {
                  pendingAction.current = null;
                  setDialog(null);
                }}
              >
                Keep editing
              </button>
              <button
                className="button secondary"
                onClick={() => {
                  const action = pendingAction.current;
                  pendingAction.current = null;
                  setDialog(null);
                  action?.();
                }}
              >
                Discard changes
              </button>
              <button
                className="button primary"
                onClick={async () => {
                  if (await save()) {
                    const action = pendingAction.current;
                    pendingAction.current = null;
                    setDialog(null);
                    action?.();
                  }
                }}
              >
                Save & continue
              </button>
            </div>
          </Modal>
        )}
      </div>
      {!initialized && (
        <div className="startup-screen" role={bootstrapError ? 'alert' : 'status'}>
          <h1>
            {bootstrapError ? 'Your workspace could not be opened' : 'Preparing your workspace'}
          </h1>
          <p>
            {bootstrapError ||
              'Checking your saved work and local compiler. First launch may take a moment.'}
          </p>
          {bootstrapError && (
            <>
              <p>Your existing recovery files have been kept.</p>
              <button
                className="button primary"
                onClick={() => setBootstrapAttempt((attempt) => attempt + 1)}
              >
                Try again
              </button>
            </>
          )}
        </div>
      )}
      {savingCopy && (
        <div className="toast" role="status">
          Saving a copy…
        </div>
      )}
    </>
  );
}
