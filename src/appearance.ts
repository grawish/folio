import { useEffect, useLayoutEffect, useState } from 'react';
import type { Appearance } from './shared/types';

const storageKey = 'folio:appearance';
const systemTheme = () => window.matchMedia('(prefers-color-scheme: dark)');

function readAppearance(): Appearance {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {
    // Storage may be unavailable in a restricted browser preview.
  }
  return 'dark';
}

function applyAppearance(appearance: Appearance, systemDark = systemTheme().matches) {
  const theme = appearance === 'system' ? (systemDark ? 'dark' : 'light') : appearance;
  document.documentElement.dataset.theme = theme;
  return theme;
}

// Apply the saved appearance before React renders the workspace.
export function initializeAppearance() {
  applyAppearance(readAppearance());
}

export function useAppearance() {
  const [appearance, setAppearance] = useState(readAppearance);
  const [systemDark, setSystemDark] = useState(() => systemTheme().matches);
  const theme = appearance === 'system' ? (systemDark ? 'dark' : 'light') : appearance;

  useEffect(() => {
    const media = systemTheme();
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useLayoutEffect(() => {
    applyAppearance(appearance, systemDark);
  }, [appearance, systemDark]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, appearance);
    } catch {
      // The current session can still switch themes without persistent storage.
    }
    void window.folio?.setAppearance(appearance).catch(console.error);
  }, [appearance]);

  return { appearance, setAppearance, theme };
}
