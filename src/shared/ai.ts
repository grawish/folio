import type { ProjectFile, TemplateId } from './types';

export type ProviderKind = 'codex' | 'claude-code' | 'openai' | 'anthropic' | 'custom';
export type ApiFormat = 'responses' | 'chat-completions' | 'anthropic';
export type AIConnection = {
  id: string;
  name: string;
  kind: ProviderKind;
  model: string;
  baseUrl?: string;
  format?: ApiFormat;
  executable?: string;
  hasKey: boolean;
  vision: 'unknown' | 'verified';
};
export type ConnectionInput = Omit<AIConnection, 'id' | 'hasKey' | 'vision'> & {
  id?: string;
  apiKey?: string;
  clearKey?: boolean;
};
export type AISettings = { connections: AIConnection[]; activeId: string | null };
export type ConnectionStatus = {
  ready: boolean;
  message: string;
  models?: { id: string; name: string }[];
  usage?: string;
};
export type LoginResult = { message: string; url?: string; loginId?: string };

export type AnnotationTool = 'select' | 'highlight' | 'rectangle' | 'pen' | 'note';
export type Point = { x: number; y: number };
export type PdfAnnotation = {
  id: string;
  versionId: string;
  page: number;
  kind: Exclude<AnnotationTool, 'select'>;
  /** Page-relative coordinates, each between zero and one. */
  rect: { x: number; y: number; width: number; height: number };
  points?: Point[];
  text: string;
  selectedText?: string;
  createdAt: string;
};
export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  annotationIds: string[];
  annotationSnapshot?: PdfAnnotation[];
  versionId?: string;
  runId?: string;
  status?: 'complete' | 'error' | 'cancelled';
};
export type VersionInfo = {
  id: string;
  label: string;
  createdAt: string;
  fingerprint: string;
  pdfFingerprint?: string;
  revision: number;
  verified: boolean;
};
export type VersionSnapshot = {
  info: VersionInfo;
  name: string;
  mainFile: string;
  files: ProjectFile[];
  templateId?: TemplateId;
  templateVersion?: number;
  runtime?: import('./runtime').RuntimePin;
  pdf: Uint8Array;
};
export type WorkspaceState = {
  schemaVersion: 1;
  projectId: string;
  messages: ChatMessage[];
  annotations: PdfAnnotation[];
  draft: string;
  attachedNoteIds: string[];
  versions: VersionInfo[];
};
export const emptyWorkspace = (projectId: string): WorkspaceState => ({
  schemaVersion: 1,
  projectId,
  messages: [],
  annotations: [],
  draft: '',
  attachedNoteIds: [],
  versions: [],
});
export type PdfPageImage = { page: number; dataUrl: string; text: string };
export type PdfNoteImage = { annotationId: string; page: number; dataUrl: string };
export type RenderedPdf = { pages: PdfPageImage[]; notes: PdfNoteImage[] };
export type AgentPhase =
  'reading' | 'editing' | 'building' | 'checking' | 'complete' | 'error' | 'cancelled';
export type AgentProgress = {
  runId: string;
  projectId: string;
  phase: AgentPhase;
  message: string;
  attempt: number;
};
export type RenderPdfRequest = {
  requestId: string;
  runId: string;
  pdf: Uint8Array;
  annotations: PdfAnnotation[];
};
export type AgentInput = {
  runId: string;
  project: import('./types').Project;
  message: string;
  annotationIds: string[];
  pdfVersionId?: string;
};
export type AgentResult = {
  runId: string;
  projectId: string;
  baseFingerprint: string;
  message: string;
  status: 'complete' | 'needs-input' | 'error' | 'cancelled';
  project?: import('./types').Project;
  build?: import('./types').BuildResult;
  version?: VersionInfo;
};
