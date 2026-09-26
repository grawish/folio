import type { BuildResult, Project } from './types';

export const fontStyles = ['regular', 'bold', 'italic', 'boldItalic'] as const;
export type FontStyle = (typeof fontStyles)[number];
export type FontTarget = 'body';
export type SelectedFont = { name: string; bytes: number };
export type FontPreview = {
  pdf: Uint8Array;
  setupFile: string;
  target: FontTarget;
};
export type FontApplyResult = { project: Project; build: BuildResult; warning?: string };
