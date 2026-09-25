import type { Diagnostic } from '../../src/shared/types';

export function parseDiagnostics(log: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const clean = log.replace(/\u001b\[[0-9;]*m/g, '');
  for (const line of clean.split('\n')) {
    const located = line.match(/^(warning|error):\s+(.+?):(\d+):\s*(.*)$/i);
    const generic = line.match(/^(warning|error):\s*(.+)$/i);
    if (located)
      diagnostics.push({
        severity: located[1].toLowerCase() as 'error' | 'warning',
        file: located[2],
        line: Number(located[3]),
        message: located[4],
      });
    else if (generic)
      diagnostics.push({
        severity: generic[1].toLowerCase() as 'error' | 'warning',
        message: generic[2],
      });
  }
  return diagnostics
    .filter(
      (diagnostic) =>
        diagnostic.message.trim() && !/^(?:Requested font |-> )/.test(diagnostic.message),
    )
    .sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'))
    .slice(0, 60);
}
