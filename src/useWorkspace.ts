import { useCallback, useEffect, useRef, useState } from 'react';
import { emptyWorkspace, type WorkspaceState } from './shared/ai';

export function useWorkspace(
  projectId: string,
  initialized: boolean,
  report: (message: string) => void,
  paused = false,
) {
  const [state, setState] = useState(() => emptyWorkspace(projectId));
  const [loadedId, setLoadedId] = useState('');
  const current = useRef(state);
  current.current = state;
  const readyId = useRef(loadedId);
  readyId.current = loadedId;
  const update = useCallback(
    (value: WorkspaceState | ((previous: WorkspaceState) => WorkspaceState)) => {
      const next = typeof value === 'function' ? value(current.current) : value;
      current.current = next;
      setState(next);
    },
    [],
  );
  useEffect(() => {
    if (!initialized) return;
    let cancelled = false;
    setLoadedId('');
    update(emptyWorkspace(projectId));
    void (window.folio?.loadWorkspace(projectId) ?? Promise.resolve(emptyWorkspace(projectId)))
      .then((next) => {
        if (!cancelled) {
          const interrupted = next.messages.filter(
            (m) =>
              m.role === 'user' &&
              m.runId &&
              !next.messages.some((reply) => reply.role === 'assistant' && reply.runId === m.runId),
          );
          if (interrupted.length)
            next = {
              ...next,
              messages: [
                ...next.messages,
                ...interrupted.map((m) => ({
                  id: crypto.randomUUID(),
                  role: 'assistant' as const,
                  runId: m.runId,
                  text: 'The earlier request was interrupted. Review your source and History before sending it again.',
                  createdAt: new Date().toISOString(),
                  annotationIds: [],
                  status: 'cancelled' as const,
                })),
              ],
            };
          update(next);
          setLoadedId(projectId);
        }
      })
      .catch((error) => {
        if (!cancelled) report(error.message);
      });
    return () => {
      cancelled = true;
      if (readyId.current === projectId && current.current.projectId === projectId)
        void window.folio
          ?.saveWorkspace(current.current)
          .catch((error) => report(`Chat recovery could not be saved: ${error.message}`));
    };
  }, [projectId, initialized, report, update]);
  const flush = useCallback(async () => {
    if (readyId.current === current.current.projectId)
      await window.folio?.saveWorkspace(current.current);
  }, []);
  useEffect(() => {
    if (paused || loadedId !== state.projectId) return;
    const timer = setTimeout(() => {
      void flush().catch((error) => report(`Chat recovery could not be saved: ${error.message}`));
    }, 350);
    return () => clearTimeout(timer);
  }, [state, loadedId, flush, report, paused]);
  const refreshVersions = useCallback(async () => {
    const id = current.current.projectId;
    const saved = await window.folio?.loadWorkspace(id);
    if (saved && current.current.projectId === id)
      update((previous) => ({ ...previous, versions: saved.versions }));
  }, [update]);
  return {
    workspace: state,
    workspaceRef: current,
    ready: loadedId === projectId,
    updateWorkspace: update,
    flushWorkspace: flush,
    refreshVersions,
  };
}
