export const dividerWidth = 6;
export const minimumSidebar = 176;
export const minimumEditor = 360;
export const minimumPreview = 420;
export type PanePreferences = { sidebar: number | null; editorRatio: number };
export const defaultPanes: PanePreferences = { sidebar: null, editorRatio: 0.5 };
export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export function readPanes(value: string | null): PanePreferences {
  try {
    const parsed = JSON.parse(value ?? 'null');
    if (
      parsed &&
      (parsed.sidebar === null ||
        (Number.isFinite(parsed.sidebar) && parsed.sidebar >= minimumSidebar)) &&
      Number.isFinite(parsed.editorRatio) &&
      parsed.editorRatio > 0 &&
      parsed.editorRatio < 1
    )
      return {
        sidebar: parsed.sidebar === null ? null : clamp(parsed.sidebar, minimumSidebar, 360),
        editorRatio: parsed.editorRatio,
      };
  } catch {
    /* Use defaults for damaged or older preferences. */
  }
  return defaultPanes;
}

export function paneLayout(width: number, open: boolean, preferences: PanePreferences) {
  const total = Math.max(
    width,
    minimumEditor + minimumPreview + dividerWidth + (open ? minimumSidebar + dividerWidth : 0),
  );
  const sidebarMax = Math.min(360, total - minimumEditor - minimumPreview - dividerWidth * 2);
  const sidebar = open
    ? clamp(
        preferences.sidebar ?? clamp(total * 0.153, minimumSidebar, 240),
        minimumSidebar,
        sidebarMax,
      )
    : 0;
  const available = total - sidebar - dividerWidth * (open ? 2 : 1);
  const editor = clamp(
    available * preferences.editorRatio,
    minimumEditor,
    available - minimumPreview,
  );
  return {
    sidebar,
    sidebarMax,
    editor,
    editorMax: available - minimumPreview,
    available,
    preview: available - editor,
  };
}
