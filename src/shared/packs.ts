import type { RuntimePin } from './runtime';

export type PackChoice = {
  key: string;
  title: string;
  description: string;
  packages: string[];
  base: RuntimePin;
  target: RuntimePin;
  bytes: number;
  retained: boolean;
  installed: boolean;
  canDownload: boolean;
  catalog: boolean;
  cachedBytes: number;
  message: string;
};
export type PackLibrary = {
  configured: boolean;
  catalogAvailable: boolean;
  catalogDate?: string;
  catalogError?: string;
  warnings: string[];
  choices: PackChoice[];
};
export type PackImportPreview = {
  token: string;
  choice: PackChoice;
  notices: string;
};
export type PackActivity = {
  id: string;
  phase: 'catalog' | 'import' | 'download' | 'assemble' | 'copy' | 'check' | 'publish';
  completed?: number;
  total?: number;
  resumed?: boolean;
};
