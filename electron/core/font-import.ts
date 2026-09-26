import { createHash } from 'node:crypto';
import {
  fontStyles,
  type FontApplyResult,
  type FontPreview,
  type FontStyle,
  type FontTarget,
  type SelectedFont,
} from '../../src/shared/fonts';
import type { BuildResult, Project } from '../../src/shared/types';
import { fontByteLimit, fontProject, readLocalFont, type LocalFont } from './local-fonts';
import { validateProject } from './project';

type Dependencies = {
  start(): Promise<void>;
  choose(style: FontStyle): Promise<string | undefined>;
  checkDisk(project: Project): Promise<void>;
  assets(project: Project): Promise<Map<string, Buffer>>;
  compile(project: Project, assets: Map<string, Buffer>): Promise<BuildResult>;
  cancel(): Promise<void>;
  save(project: Project, assets: Map<string, Buffer>, build: BuildResult): Promise<FontApplyResult>;
};
const key = (project: Project) => JSON.stringify(validateProject(project));
const assetsKey = (assets: Map<string, Buffer>) =>
  JSON.stringify(
    [...assets]
      .map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
type Session = {
  id: string;
  project: Project;
  fonts: Map<FontStyle, LocalFont>;
  pending?: {
    project: Project;
    assets: Map<string, Buffer>;
    assetsKey: string;
    build: BuildResult;
  };
};

export class FontImport {
  private session?: Session;
  private operation?: Promise<unknown>;
  private applying?: Promise<FontApplyResult>;
  constructor(private deps: Dependencies) {}
  requireIdle() {
    if (this.session || this.operation || this.applying)
      throw new Error('Finish or cancel the font preview first.');
  }
  private current(id: string) {
    if (!this.session || this.session.id !== id) throw new Error('Open a new font setup.');
    return this.session;
  }
  private run<T>(id: string, action: (session: Session) => Promise<T>) {
    if (this.operation || this.applying)
      throw new Error('Wait for the current font operation to finish.');
    const session = this.current(id);
    const promise = action(session).finally(() => {
      if (this.operation === promise) this.operation = undefined;
    });
    this.operation = promise;
    return promise;
  }
  begin(id: string, value: unknown) {
    this.requireIdle();
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))
      throw new Error('Invalid font setup.');
    this.session = { id, project: validateProject(value), fonts: new Map() };
    return this.run(id, async (session) => {
      try {
        await this.deps.start();
        await this.deps.checkDisk(session.project);
        this.current(id);
      } catch (error) {
        if (this.session === session) this.session = undefined;
        throw error;
      }
    });
  }
  choose(id: string, style: FontStyle): Promise<SelectedFont | null> {
    if (!fontStyles.includes(style)) throw new Error('Invalid font style.');
    return this.run(id, async (session) => {
      const filename = await this.deps.choose(style);
      this.current(id);
      if (!filename) return null;
      const font = await readLocalFont(filename);
      this.current(id);
      const total = [...session.fonts]
        .filter(([slot]) => slot !== style)
        .reduce((sum, [, item]) => sum + item.data.length, font.data.length);
      if (total > fontByteLimit)
        throw new Error('Choose a font family whose files total no more than 20 MB.');
      session.fonts.set(style, font);
      session.pending = undefined;
      return { name: font.name, bytes: font.data.length };
    });
  }
  remove(id: string, style: FontStyle) {
    return this.run(id, async (session) => {
      if (!fontStyles.includes(style)) throw new Error('Invalid font style.');
      session.fonts.delete(style);
      session.pending = undefined;
    });
  }
  preview(id: string, value: unknown, target: FontTarget): Promise<FontPreview> {
    return this.run(id, async (session) => {
      const project = validateProject(value);
      if (key(project) !== key(session.project))
        throw new Error(
          'Your source changed. Close this setup and start again with your latest edits.',
        );
      session.pending = undefined;
      await this.deps.checkDisk(project);
      const previousAssets = await this.deps.assets(project);
      this.current(id);
      const next = fontProject(project, id, session.fonts, target);
      const assets = new Map([...previousAssets, ...next.assets]);
      const bytes =
        [...assets.values()].reduce((sum, value) => sum + value.length, 0) +
        next.project.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
      if (assets.size + next.project.files.length > 200 || bytes > 25 * 1024 * 1024)
        throw new Error('These fonts would exceed the project limit of 200 files or 25 MB.');
      const build = await this.deps.compile(next.project, assets);
      this.current(id);
      if (build.status !== 'success' || !build.pdf)
        throw new Error(
          `The font preview could not compile. Your project is unchanged. ${build.log.slice(-1600)}`,
        );
      session.pending = {
        project: next.project,
        assets: next.assets,
        assetsKey: assetsKey(previousAssets),
        build,
      };
      return { pdf: build.pdf, setupFile: next.setupFile, target };
    });
  }
  apply(id: string, value: unknown): Promise<FontApplyResult> {
    if (this.operation || this.applying)
      throw new Error('Wait for the current font operation to finish.');
    const session = this.current(id),
      pending = session.pending;
    if (!pending) throw new Error('Build and review the font preview before saving.');
    const project = validateProject(value);
    if (key(project) !== key(session.project))
      throw new Error('Your source changed. Build a new font preview before saving.');
    const apply = async () => {
      await this.deps.checkDisk(project);
      if (assetsKey(await this.deps.assets(project)) !== pending.assetsKey)
        throw new Error(
          'Project assets changed since the preview. Close this setup and review the outside changes.',
        );
      const result = await this.deps.save(pending.project, pending.assets, pending.build);
      this.session = undefined;
      return result;
    };
    this.applying = apply().finally(() => {
      this.applying = undefined;
    });
    return this.applying;
  }
  async cancel(id?: string) {
    if (id && this.session?.id !== id) return;
    if (this.applying) await this.applying.catch(() => {});
    this.session = undefined;
    await this.deps.cancel();
    await this.operation?.catch(() => {});
  }
}
