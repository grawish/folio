// Pure fail-closed input/identity guards for scripts/profile-renderer-idle-spikes.mjs.
// No Electron, filesystem or network access here: the caller supplies already-loaded
// argv values, the parsed 120-cycle scripts/profile-process-resources.mjs --long-session
// seed report, and the freshly hashed candidate application's app.asar digest.
//
// This diagnostic targets the rare renderer-dominated return-idle CPU exceedances
// described by PERF-01 (exact phase names `cycle-N-return-idle`). It never widens
// or narrows the 2.5-second idle dwell that is the actual workload threshold being
// diagnosed: this guard rejects any extra CLI flag that could change it.
export function rendererIdleSpikeInputs({
  platform,
  arch,
  executableArg,
  seedArg,
  argvLength,
  cycles,
  seed,
  appAsarSha256,
}) {
  if (platform !== 'darwin' || arch !== 'arm64')
    throw new Error('The renderer idle-spike diagnostic requires an Apple silicon Mac.');
  if (!executableArg || !seedArg)
    throw new Error(
      'Provide a packaged Folio executable and a completed 120-cycle synthetic process-profile directory.',
    );
  if (!Number.isInteger(argvLength) || argvLength < 4 || argvLength > 5)
    throw new Error(
      'Usage: executable path, seed process-profile directory, optional cycle count. No other flags: this diagnostic never changes the 2.5-second idle dwell.',
    );
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 360)
    throw new Error('Choose 1-360 cycles for the renderer idle-spike diagnostic.');
  if (
    !seed ||
    !seed.passed ||
    !seed.longSession ||
    seed.cycles !== 120 ||
    seed.errors?.length ||
    seed.storage?.at(-1)?.label !== 'closed'
  )
    throw new Error(
      'Use a completed 120-cycle synthetic process-profile fixture (scripts/profile-process-resources.mjs --long-session), never a personal app profile.',
    );
  if (typeof appAsarSha256 !== 'string' || !appAsarSha256)
    throw new Error('Missing candidate application identity.');
  if (typeof seed.appAsarSha256 !== 'string' || !seed.appAsarSha256)
    throw new Error('Seed report is missing its recorded application identity.');
  if (appAsarSha256 !== seed.appAsarSha256)
    throw new Error(
      'The renderer idle-spike diagnostic requires the exact unchanged seed application; it never profiles a different build.',
    );
  return {
    mode: 'renderer-idle-spike-scan',
    cycles,
    appAsarSha256,
    seedAppAsarSha256: seed.appAsarSha256,
    seedCycles: seed.cycles,
  };
}
