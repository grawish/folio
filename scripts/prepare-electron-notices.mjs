import path from 'node:path';
import { Arch } from 'builder-util';
import { tsImport } from 'tsx/esm/api';

// electron-builder runs this before copying extraResources, including direct
// CLI builds. No network request or change to the installed Electron runtime.
export default async function beforePack(context) {
  const target = `${context.electronPlatformName}-${Arch[context.arch]}`;
  // The notice bundles are the complete upstream originals for the pinned
  // Electron, Tectonic and Biber releases. Windows and Linux previews ship the
  // same originals; their platform binary inventories are tracked separately.
  if (!['darwin-arm64', 'win32-x64', 'linux-x64'].includes(target))
    throw new Error(`Folio does not package ${target}.`);
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
