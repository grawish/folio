export const defaultPreferences = {
  'folio:auto': 'true',
  'folio:autosave': 'false',
  'folio:font': '14',
  'folio:appearance': 'dark',
  'folio:panes': '{"sidebar":null,"editorRatio":0.5}',
};
export type PreferenceKey = keyof typeof defaultPreferences;
export type Preferences = Record<PreferenceKey, string>;
export type PreferencePatch = Partial<Preferences>;

export function validatePreference(key: unknown, value: unknown): asserts key is PreferenceKey {
  if (
    typeof key !== 'string' ||
    !Object.hasOwn(defaultPreferences, key) ||
    typeof value !== 'string' ||
    value.length > 160
  )
    throw new Error('Invalid workspace preference.');
  if (key === 'folio:auto' || key === 'folio:autosave') {
    if (value !== 'true' && value !== 'false')
      throw new Error('Invalid automatic-action preference.');
  } else if (key === 'folio:font') {
    if (!['11', '12', '13', '14', '16', '18'].includes(value))
      throw new Error('Invalid editor text size.');
  } else if (key === 'folio:appearance') {
    if (!['light', 'dark', 'system'].includes(value)) throw new Error('Invalid appearance.');
  } else {
    const p = JSON.parse(value);
    if (
      !p ||
      Array.isArray(p) ||
      Object.keys(p).sort().join(',') !== 'editorRatio,sidebar' ||
      (p.sidebar !== null && (!Number.isFinite(p.sidebar) || p.sidebar < 176 || p.sidebar > 360)) ||
      !Number.isFinite(p.editorRatio) ||
      p.editorRatio <= 0 ||
      p.editorRatio >= 1
    )
      throw new Error('Invalid pane sizes.');
  }
}

export function validatePreferencePatch(value: unknown): PreferencePatch {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 5)
    throw new Error('Invalid workspace preferences.');
  const out: PreferencePatch = {};
  for (const [key, item] of Object.entries(value)) {
    validatePreference(key, item);
    out[key] = item as string;
  }
  return out;
}

export function validatePreferences(value: unknown): Preferences {
  const out = validatePreferencePatch(value);
  if (Object.keys(out).length !== Object.keys(defaultPreferences).length)
    throw new Error('Incomplete workspace preferences.');
  return out as Preferences;
}
