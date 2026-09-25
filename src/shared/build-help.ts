import type { BuildResult } from './types';

export type BuildHelp = {
  kind: 'package' | 'file' | 'font' | 'engine' | 'syntax' | 'limit';
  title: string;
  steps: string[];
};

// Keep advice separate from diagnostics: the original messages and source links
// remain available, including when a failure does not match a known pattern.
export function buildHelp(result: BuildResult | null): BuildHelp | undefined {
  if (!result || result.status !== 'error' || result.runtimeUnavailable) return;
  const messages = result.diagnostics
    .filter((item) => item.severity === 'error')
    .map((item) => item.message);
  for (const message of messages) {
    const missing = message.match(/\bFile [`'"]([^`'"\r\n]+)['"] not found/i);
    if (missing) {
      const filename = missing[1];
      // Bound display text without changing the raw diagnostic or its link.
      const label = filename.length > 160 ? `${filename.slice(0, 157)}…` : filename;
      if (/\.(sty|cls)$/i.test(filename))
        return {
          kind: 'package',
          title: `Missing LaTeX package or class: ${label}`,
          steps: [
            'If this file came with the template, add it to the project folder and check its relative path.',
            'Otherwise, adapt the template to the bundled packages. Folio cannot download missing packages during a build.',
          ],
        };
      if (/\.(otf|ttf)$/i.test(filename)) return fontHelp(label);
      return {
        kind: 'file',
        title: `Missing project file: ${label}`,
        steps: [
          'Add the missing file inside the project folder, or correct its name and relative path in the source.',
          'After adding it, review any outside-file changes in Folio and compile again.',
        ],
      };
    }
    const font = message.match(/\bThe font "([^"\r\n]{1,300})" cannot be found/i);
    if (font) return fontHelp(font[1]);
  }

  // iftex prints its requirement in the raw engine output, without an error:
  // prefix. Do not confuse the generic "XeTeX engine ... error" with a request
  // for another engine, or infer one just from a source line/package name.
  const engine = result.log
    .replace(/\u001b\[[0-9;]*m/g, '')
    .match(/^\s*\*?\s*(LuaTeX|pdfTeX|LuaLaTeX|pdfLaTeX) is required to compile this document\./im);
  if (engine)
    return {
      kind: 'engine',
      title: `This document requires ${engine[1]}`,
      steps: [
        'Folio uses a bundled XeTeX-based compiler. Switching to this engine is not available in Folio.',
        'Use a XeLaTeX-compatible version of the template, or adapt its engine-specific commands. Removing the engine check alone may not fix it.',
      ],
    };
  if (messages.some((message) => /Compilation exceeded the \d+-second time limit\./.test(message)))
    return {
      kind: 'limit',
      title: 'This build took too long',
      steps: [
        'Check recent edits for a repeating command or unusually large content, then simplify and compile again.',
        'The last successful PDF stays visible; it may not include your latest edits.',
      ],
    };
  if (
    messages.some((message) =>
      /Undefined control sequence|Missing [{$}].*inserted|Extra }, or forgotten|Runaway argument|File ended while scanning/.test(
        message,
      ),
    )
  )
    return {
      kind: 'syntax',
      title: 'Check the TeX near the reported line',
      steps: [
        'Select a source-linked error below. Check command spelling and matching braces on that line and the lines just before it.',
        'If the command belongs to a package, check that its package is included. Fix the first error, then compile again.',
      ],
    };
}

function fontHelp(name: string): BuildHelp {
  const label = name.length > 160 ? `${name.slice(0, 157)}…` : name;
  return {
    kind: 'font',
    title: `Font not found: ${label}`,
    steps: [
      'For a fontspec document, try the bundled font with \\setmainfont{lmroman10-regular.otf}. This can change the layout.',
      'Or put the required .otf or .ttf files inside the project folder and reference their relative paths. A font installed on your Mac may not be available to the isolated compiler.',
    ],
  };
}
