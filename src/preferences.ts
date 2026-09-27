import { useSyncExternalStore } from 'react';
import {
  defaultPreferences,
  validatePreference,
  type PreferenceKey,
  type Preferences,
} from './shared/preferences';
import { PreferenceWrites } from './shared/preference-writes';

let current: Preferences = { ...defaultPreferences };
const listeners = new Set<() => void>();
const writes = new PreferenceWrites(
  async (patch) => {
    await window.folio?.savePreferences(patch);
  },
  () => {
    for (const listener of listeners) listener();
  },
);
function mirror(key: PreferenceKey, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Native storage remains authoritative. */
  }
}
export async function initializePreferences() {
  const legacy: Preferences = { ...defaultPreferences };
  for (const key of Object.keys(legacy) as PreferenceKey[]) {
    try {
      const value = localStorage.getItem(key);
      validatePreference(key, value);
      legacy[key] = value!;
    } catch {
      /* Invalid or inaccessible old entries use their existing defaults. */
    }
  }
  current = window.folio ? await window.folio.loadPreferences(legacy) : legacy;
  for (const key of Object.keys(current) as PreferenceKey[]) mirror(key, current[key]);
}
export const readPreference = (key: PreferenceKey) => current[key];
export function writePreference(key: PreferenceKey, value: string) {
  validatePreference(key, value);
  if (current[key] === value) return;
  current = { ...current, [key]: value };
  mirror(key, value);
  writes.set({ [key]: value });
}
export const flushPreferences = () => writes.flush();
export function usePreferenceError() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => writes.error,
  );
}
