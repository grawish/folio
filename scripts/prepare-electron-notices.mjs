import path from 'node:path';
import { Arch } from 'builder-util';
import { tsImport } from 'tsx/esm/api';

// electron-builder runs this before copying extraResources, including direct
// CLI builds. No network request or change to the installed Electron runtime.
export default async function beforePack(context) {
  if (context.electronPlatformName !== 'darwin' || context.arch !== Arch.arm64)
    throw new Error('Folio packages only the pinned Apple silicon Electron notices.');
  const root = context.packager.projectDir;
  const { prepareElectronNotices } = await tsImport('./electron-notices.ts', import.meta.url);
  const notices = await prepareElectronNotices(path.join(root, 'artifacts/electron-notices'), root);
  const { prepareTectonicNotices } = await tsImport('./tectonic-notices.ts', import.meta.url);
  await prepareTectonicNotices(path.join(root, 'artifacts/tectonic-notices'), root);
  const { prepareBiberNotices } = await tsImport('./biber-notices.ts', import.meta.url);
  await prepareBiberNotices(path.join(root, 'artifacts/biber-notices'), root);
  if (context.packager.info.framework.version !== notices.electronVersion)
    throw new Error('The selected Electron runtime does not match the pinned original notices.');
}
