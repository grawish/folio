// Pure fail-closed input/identity guards for the mounted-editor project-switch
// diagnostic mode of scripts/profile-v8-resources.mjs. No Electron, filesystem
// or network access here: the caller supplies already-loaded argv values and
// the parsed 120-cycle seed report plus the freshly hashed candidate app.
//
// Returns null when the diagnostic argument does not select this mode, so
// callers can use it purely as a guard without branching twice. Throws with a
// specific reason on any mismatch instead of silently skipping the check.
export function projectSwitchRetentionInputs({
  diagnosticArg,
  cycles,
  argvLength,
  platform,
  arch,
  executableArg,
  seedArg,
  seed,
  appAsarSha256,
}) {
  if (diagnosticArg !== '--retention-project-switch') return null;
  if (platform !== 'darwin' || arch !== 'arm64')
    throw new Error('The project-switch retention diagnostic requires an Apple silicon Mac.');
  if (!executableArg || !seedArg)
    throw new Error(
      'Provide a packaged Folio executable and a completed synthetic process-profile directory.',
    );
  if (!Number.isInteger(argvLength) || argvLength > 6)
    throw new Error('Unexpected extra arguments for the project-switch retention diagnostic.');
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 20)
    throw new Error('Choose 1-20 cycles for the project-switch retention diagnostic.');
  if (
    !seed ||
    !seed.passed ||
    !seed.longSession ||
    seed.cycles !== 120 ||
    seed.errors?.length ||
    seed.storage?.at(-1)?.label !== 'closed'
  )
    throw new Error('Use the completed 120-cycle synthetic fixture, never a personal app profile.');
  if (typeof appAsarSha256 !== 'string' || !appAsarSha256)
    throw new Error('Missing candidate application identity.');
  if (appAsarSha256 !== seed.appAsarSha256)
    throw new Error(
      'The project-switch retention diagnostic requires the unchanged seed application; it never compares a changed app.',
    );
  return {
    mode: 'mounted-editor-project-switch',
    requiresUnchangedApp: true,
    appAsarSha256,
    seedAppAsarSha256: seed.appAsarSha256,
    forcesGarbageCollection: false,
  };
}
