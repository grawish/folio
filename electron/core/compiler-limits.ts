export const compilerLimits = Object.freeze({ fileBytes: 128 * 1024 * 1024, openFiles: 256 });

// Only this fixed program is shell syntax. The executable and every argument
// stay separate positional parameters, including project names and paths.
// bash uses KiB for -f; invoke it directly without profile/startup files.
// macOS's CPU signal is catchable: Compiler.run must also keep its group timer.
const limitScript = `
if ! { ulimit -S -H -c 0 &&
       ulimit -S -H -t "$1" &&
       ulimit -S -H -f 131072 &&
       ulimit -S -H -n 256; }; then
  printf '%s\\n' 'error: macOS could not apply the compiler resource limits.' >&2
  exit 125
fi
shift
exec "$@"
`;

// The app owns the other end of descriptor 3. EOF also arrives when the app is
// killed, so this idle watcher does not depend on JavaScript timers or cleanup.
// It stays in the detached compiler group and therefore cannot target a reused
// group ID. Close the descriptor before exec so compiler descendants never keep
// the parent connection alive. Redirect both outputs to avoid holding log pipes.
const parentWatch = `
folio_group=$$
( while IFS= read -r -u 3 folio_parent; do :; done; kill -KILL -- -"$folio_group" ) >/dev/null 2>&1 &
exec "$@" 3<&-
`;

export function limitedCompilerLaunch(
  command: string,
  args: string[],
  timeoutMs: number,
  watchParent = false,
) {
  if (process.platform !== 'darwin') throw new Error('Compiler resource limits require macOS.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    throw new Error('The compiler time limit is invalid.');
  return {
    command: '/bin/bash',
    args: [
      '--noprofile',
      '--norc',
      '-c',
      watchParent ? limitScript.replace('exec "$@"', () => parentWatch) : limitScript,
      'folio-compiler-limits',
      String(Math.ceil(timeoutMs / 1000)),
      command,
      ...args,
    ],
  };
}
