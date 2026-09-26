import { useEffect, useState } from 'react';
import { AlertTriangle, FileText, Info, Network, Settings2, ShieldCheck } from 'lucide-react';
import type { CompilerBackup } from '../shared/migration';
import type { AISettings } from '../shared/ai';
import type { Appearance, RuntimeStatus } from '../shared/types';
import { version } from '../../package.json';
import { Modal } from './Modal';
import { AIConnections } from './AIConnections';

export function SettingsModal({
  appearance,
  setAppearance,
  autoSave,
  setAutoSave,
  onResetPanes,
  onInterruptedImports,
  autoCompile,
  setAutoCompile,
  fontSize,
  setFontSize,
  runtime,
  onRepairRuntime,
  projectId,
  onCompareCompiler,
  onSupportBundle,
  connections,
  onConnections,
  initialTab = 'general',
  onClose,
}: {
  appearance: Appearance;
  setAppearance(value: Appearance): void;
  autoSave: boolean;
  setAutoSave(value: boolean): void;
  onResetPanes(): void;
  onInterruptedImports(): void;
  autoCompile: boolean;
  setAutoCompile(value: boolean): void;
  fontSize: number;
  setFontSize(value: number): void;
  runtime: RuntimeStatus | null;
  onRepairRuntime(): Promise<void>;
  projectId: string;
  onCompareCompiler(): void;
  onSupportBundle(): void;
  connections: AISettings;
  onConnections(settings: AISettings): void;
  initialTab?: 'general' | 'ai' | 'about' | 'privacy';
  onClose(): void;
}) {
  const [tab, setTab] = useState<string>(initialTab);
  const [repairing, setRepairing] = useState(false),
    [repairError, setRepairError] = useState('');
  const [backups, setBackups] = useState<CompilerBackup[]>([]);
  useEffect(() => {
    let cancelled = false;
    void window.folio
      ?.compilerBackups(projectId)
      .then((value) => {
        if (!cancelled) setBackups(value);
      })
      .catch((error) => {
        if (!cancelled) setRepairError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  return (
    <Modal wide title="Settings" onClose={onClose}>
      <div className="settings-layout">
        <nav className="settings-navigation" aria-label="Settings sections">
          {[
            ['general', 'General', Settings2],
            ['ai', 'AI connections', Network],
            ['editor', 'Editor & PDF', FileText],
            ['privacy', 'Privacy', ShieldCheck],
            ['about', 'About', Info],
          ].map(([id, label, Icon]) => (
            <button
              key={id as string}
              className={tab === id ? 'active' : ''}
              onClick={() => setTab(id as string)}
            >
              <Icon size={17} />
              {label as string}
            </button>
          ))}
        </nav>
        {tab === 'ai' ? (
          <AIConnections settings={connections} onChange={onConnections} />
        ) : (
          <div className="settings-content">
            {tab === 'general' && (
              <>
                <h3>General</h3>
                <div className="setting-row">
                  <div>
                    <strong>Appearance</strong>
                    <p>Choose a theme or follow your system.</p>
                  </div>
                  <select
                    aria-label="Appearance"
                    value={appearance}
                    onChange={(event) => setAppearance(event.target.value as Appearance)}
                  >
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                    <option value="system">System</option>
                  </select>
                </div>
                <p className="settings-hint">
                  Your draft, chat, and PDF notes are saved locally for recovery. Use Save to keep
                  your project folder up to date.
                </p>
                <div className="setting-row">
                  <div>
                    <strong>Autosave project</strong>
                    <p>
                      Save source, chat and notes after a 2-second pause. Save a new project once to
                      choose its folder. Outside changes or errors pause autosave.
                    </p>
                  </div>
                  <label className="auto-label">
                    <input
                      type="checkbox"
                      aria-label="Autosave project"
                      checked={autoSave}
                      onChange={(event) => setAutoSave(event.target.checked)}
                    />
                    <span className="toggle" />
                  </label>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>Workspace panes</strong>
                    <p>Drag a divider or focus it and use Left/Right. Enter resets that divider.</p>
                  </div>
                  <button className="button secondary" onClick={onResetPanes}>
                    Reset pane sizes
                  </button>
                </div>
                <p className="settings-hint">
                  In chat, Enter sends your message. Shift + Enter starts a new line.
                </p>
                <div className="setting-row">
                  <div>
                    <strong>Interrupted imports</strong>
                    <p>Finish a ZIP import that stopped, or review its unfinished copy.</p>
                  </div>
                  <button className="button secondary" onClick={onInterruptedImports}>
                    Review imports
                  </button>
                </div>
              </>
            )}
            {tab === 'editor' && (
              <>
                <h3>Editor & PDF</h3>
                <div className="setting-row">
                  <div>
                    <strong>Automatic preview</strong>
                    <p>Recompile after you pause typing.</p>
                  </div>
                  <label className="auto-label">
                    <input
                      aria-label="Automatic preview"
                      type="checkbox"
                      checked={autoCompile}
                      onChange={(event) => setAutoCompile(event.target.checked)}
                    />
                    <span className="toggle" />
                  </label>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>Editor text size</strong>
                    <p>A comfortable size for your source.</p>
                  </div>
                  <select
                    aria-label="Editor text size"
                    value={fontSize}
                    onChange={(event) => setFontSize(Number(event.target.value))}
                  >
                    {[11, 12, 13, 14, 16, 18].map((n) => (
                      <option key={n} value={n}>
                        {n}px
                      </option>
                    ))}
                  </select>
                </div>
                <p className="settings-hint">
                  Use Fit to width in the PDF toolbar to reset the zoom. PDF notes stay out of
                  exported PDFs.
                </p>
              </>
            )}
            {tab === 'privacy' && (
              <>
                <h3>Privacy</h3>
                <section className="privacy-row">
                  <h4>Saved on your computer</h4>
                  <p>
                    Projects, chats, notes, and version history stay on this device. Saving a
                    project also saves its chat and history beside the source files.
                  </p>
                </section>
                <section className="privacy-row">
                  <h4>Shared when you send</h4>
                  <p>
                    Your message, source, conversation context, and PDF images go to the AI
                    connection selected in Settings. PDF notes include their page and marked area.
                  </p>
                </section>
                <section className="privacy-row">
                  <h4>Your keys stay protected</h4>
                  <p>
                    API keys use protected storage on this device. Subscription apps handle their
                    own sign-in.
                  </p>
                </section>
                <section className="privacy-row">
                  <h4>Clean PDF exports</h4>
                  <p>
                    Exported PDFs contain your resume without annotations or chat. Source ZIP
                    exports include the project conversation and version history.
                  </p>
                </section>
                <section className="privacy-row">
                  <h4>Ask for help without sharing your resume</h4>
                  <p>
                    Review a small support summary, choose its sections, then save a ZIP on your
                    Mac.
                  </p>
                  <button
                    className="button secondary small"
                    disabled={!window.folio}
                    onClick={onSupportBundle}
                  >
                    Review support bundle
                  </button>
                </section>
              </>
            )}
            {tab === 'about' && (
              <>
                <h3>About Folio</h3>
                <p>Version {version} · Development preview</p>
                <div
                  className={`runtime-details${runtime && !runtime.ready ? ' runtime-unavailable' : ''}`}
                >
                  <div>
                    {runtime && !runtime.ready ? (
                      <AlertTriangle size={20} />
                    ) : (
                      <ShieldCheck size={20} />
                    )}
                    <strong>
                      {runtime?.ready
                        ? 'Your LaTeX compiler is ready.'
                        : runtime
                          ? 'Your compiler needs attention.'
                          : 'Runtime information'}
                    </strong>
                  </div>
                  <p>
                    {runtime?.message ??
                      'Use the desktop application to compile, open, save, and export your files.'}
                  </p>
                  {runtime && (
                    <dl>
                      <dt>Engine</dt>
                      <dd>{runtime.engine}</dd>
                      <dt>Resources</dt>
                      <dd>{runtime.bundle}</dd>
                      <dt>Platform</dt>
                      <dd>{runtime.platform}</dd>
                      <dt>Isolation</dt>
                      <dd>{runtime.isolation}</dd>
                    </dl>
                  )}
                </div>
                <div className="setting-row">
                  <div>
                    <strong>Repair compiler</strong>
                    <p>
                      Restore the recorded version from verified local files. Your resume and its
                      compiler choice stay the same.
                    </p>
                  </div>
                  <button
                    className="button secondary small"
                    disabled={!runtime?.canRepair || repairing}
                    onClick={() => {
                      setRepairing(true);
                      setRepairError('');
                      void onRepairRuntime()
                        .catch((error) => setRepairError(error.message))
                        .finally(() => setRepairing(false));
                    }}
                  >
                    {repairing ? 'Repairing…' : 'Repair compiler'}
                  </button>
                </div>
                {repairError && <p role="alert">{repairError}</p>}
                {runtime?.pin &&
                  runtime.defaultPin?.id &&
                  runtime.pin.id !== runtime.defaultPin.id && (
                    <div className="setting-row">
                      <div>
                        <strong>Try the included compiler</strong>
                        <p>
                          Compare PDFs and keep a backup before changing this project’s compiler.
                        </p>
                      </div>
                      <button
                        className="button secondary small"
                        disabled={repairing}
                        onClick={onCompareCompiler}
                      >
                        Compare compilers
                      </button>
                    </div>
                  )}
                {!!backups.length && (
                  <section className="compiler-backups" aria-label="Compiler backups">
                    <h4>Compiler backups</h4>
                    <p className="settings-hint">
                      Import a backup’s source ZIP to restore it as a separate project. Its previous
                      compiler choice and saved history are kept.
                    </p>
                    {backups.map((backup) => (
                      <div className="setting-row" key={backup.id}>
                        <div>
                          <strong>{new Date(backup.createdAt).toLocaleString()}</strong>
                          <p>
                            {backup.from.bundle} → {backup.to.bundle}
                          </p>
                        </div>
                        <button
                          className="button secondary small"
                          onClick={() =>
                            void window.folio
                              ?.showCompilerBackup(projectId, backup.id)
                              .catch((error) => setRepairError(error.message))
                          }
                        >
                          Show backup
                        </button>
                      </div>
                    ))}
                  </section>
                )}
                <p className="settings-hint">
                  LaTeX builds locally. You can edit and build without an AI connection.
                </p>
                <p className="settings-hint">Folio is built for Macs with Apple silicon.</p>
              </>
            )}
          </div>
        )}
      </div>
      <div className="modal-actions">
        <button className="button primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
