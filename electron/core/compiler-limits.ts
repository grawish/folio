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

export function limitedCompilerLaunch(command: string, args: string[], timeoutMs: number) {
  if (process.platform !== 'darwin') throw new Error('Compiler resource limits require macOS.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    throw new Error('The compiler time limit is invalid.');
  return {
    command: '/bin/bash',
    args: [
      '--noprofile',
      '--norc',
      '-c',
      limitScript,
      'folio-compiler-limits',
      String(Math.ceil(timeoutMs / 1000)),
      command,
      ...args,
    ],
  };
}
