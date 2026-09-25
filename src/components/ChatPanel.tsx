import {
  CheckCircle2,
  History,
  LoaderCircle,
  Paperclip,
  Send,
  Square,
  TriangleAlert,
  Undo2,
  X,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { AgentProgress, PdfAnnotation, WorkspaceState } from '../shared/ai';
import { NoteThumbnail } from './NoteThumbnail';

export function ChatPanel({
  workspace,
  update,
  progress,
  connected,
  ready,
  onSend,
  onStop,
  onSettings,
  onHistory,
  onUndo,
  onTemplates,
  onNote,
}: {
  workspace: WorkspaceState;
  update: (next: WorkspaceState) => void;
  progress: AgentProgress | null;
  connected: boolean;
  ready: boolean;
  onSend(): void;
  onStop(): void;
  onSettings(): void;
  onHistory(versionId?: string): void;
  onUndo(versionId: string): void;
  onTemplates(): void;
  onNote(note: PdfAnnotation): void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const busy = !!progress && !['complete', 'error', 'cancelled'].includes(progress.phase);
  const attached = workspace.annotations.filter((note) =>
    workspace.attachedNoteIds.includes(note.id),
  );
  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' });
  }, [workspace.messages.length, progress?.phase]);
  const noteChip = (note: PdfAnnotation, removable = false) => (
    <span className="chat-note" key={note.id}>
      <button type="button" onClick={() => onNote(note)} title={note.selectedText || note.text}>
        <NoteThumbnail projectId={workspace.projectId} note={note} />
        <span>
          Page {note.page} · {note.text || `${note.kind} note`}
        </span>
      </button>
      {removable && (
        <button
          type="button"
          aria-label={`Remove attached note: ${note.text || note.kind}`}
          onClick={() =>
            update({
              ...workspace,
              attachedNoteIds: workspace.attachedNoteIds.filter((id) => id !== note.id),
            })
          }
        >
          <X size={13} />
        </button>
      )}
    </span>
  );
  return (
    <section className="chat-panel" aria-label="Resume chat">
      {!connected && (
        <div className="chat-connection-notice">
          <span>Connect an AI in Settings to start chatting.</span>
          <button className="button secondary small" onClick={onSettings}>
            Open Settings
          </button>
        </div>
      )}
      <div className="chat-scroll" ref={scroll} aria-live="polite">
        {!workspace.messages.length ? (
          <div className="chat-welcome">
            <h2>Let’s build your resume.</h2>
            <p>Tell me about your experience, or ask for a change to the PDF.</p>
            <div className="chat-suggestions">
              <button
                onClick={() =>
                  update({
                    ...workspace,
                    draft: 'Help me write my first resume. Ask me what you need to know.',
                  })
                }
              >
                Write my first resume
              </button>
              <button
                onClick={() =>
                  update({
                    ...workspace,
                    draft: 'Review my resume and suggest improvements before changing it.',
                  })
                }
              >
                Improve this resume
              </button>
              <button onClick={onTemplates}>Choose a template</button>
            </div>
          </div>
        ) : (
          workspace.messages.map((message) => (
            <article key={message.id} className={`chat-message ${message.role}`}>
              <div className="chat-avatar" aria-hidden="true">
                {message.role === 'user' ? 'U' : 'F'}
              </div>
              <div className="chat-message-body">
                <div className="chat-author">
                  <strong>{message.role === 'user' ? 'You' : 'Folio'}</strong>
                  <time>
                    {new Date(message.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                </div>
                <p>{message.text}</p>
                <div className="chat-notes">
                  {(
                    message.annotationSnapshot ??
                    workspace.annotations.filter((note) => message.annotationIds.includes(note.id))
                  ).map((note) => noteChip(note))}
                </div>
                {message.status === 'error' && (
                  <div className="chat-error-actions">
                    <TriangleAlert size={14} />
                    <button onClick={onSettings}>Open Settings</button>
                    <button
                      onClick={() => {
                        const index = workspace.messages.findIndex((m) => m.id === message.id);
                        const previous = workspace.messages
                          .slice(0, index)
                          .reverse()
                          .find((m) => m.role === 'user');
                        if (previous) {
                          const restored = (
                            previous.annotationSnapshot ??
                            workspace.annotations.filter((note) =>
                              previous.annotationIds.includes(note.id),
                            )
                          ).map((note) => ({ ...note, id: crypto.randomUUID() }));
                          update({
                            ...workspace,
                            draft: previous.text,
                            annotations: [...workspace.annotations, ...restored],
                            attachedNoteIds: restored.map((note) => note.id),
                          });
                        }
                      }}
                    >
                      Edit and retry
                    </button>
                  </div>
                )}
                {message.versionId && message.role === 'assistant' && (
                  <div className="chat-result-actions">
                    <span>
                      <CheckCircle2 size={15} />
                      PDF checked
                    </span>
                    <button onClick={() => onHistory(message.versionId)}>
                      <History size={14} />
                      Compare changes
                    </button>
                    <button onClick={() => onUndo(message.versionId!)} disabled={busy}>
                      <Undo2 size={14} />
                      Undo
                    </button>
                  </div>
                )}
              </div>
            </article>
          ))
        )}
        {busy && (
          <article className="chat-message assistant">
            <div className="chat-avatar" aria-hidden="true">
              F
            </div>
            <div className="chat-message-body">
              <strong>Folio</strong>
              <div className="agent-progress">
                {(['reading', 'editing', 'building', 'checking'] as const).map((phase, index) => {
                  const active = ['reading', 'editing', 'building', 'checking'].indexOf(
                      progress.phase,
                    ),
                    done = index < active;
                  return (
                    <div key={phase} className={index === active ? 'active' : done ? 'done' : ''}>
                      {done ? (
                        <CheckCircle2 size={19} />
                      ) : index === active ? (
                        <LoaderCircle size={19} className="spin" />
                      ) : (
                        <span className="progress-dot" />
                      )}
                      <span>
                        {
                          [
                            'Read your message and PDF notes',
                            'Update the resume',
                            'Build the PDF',
                            'Check the finished pages',
                          ][index]
                        }
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="muted">
                {progress.message}
                {progress.attempt > 1 ? ` (Attempt ${progress.attempt} of 3)` : ''}
              </p>
            </div>
          </article>
        )}
      </div>
      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && ready && connected) onSend();
        }}
      >
        <textarea
          aria-label="Message the resume agent"
          placeholder="Describe a change or add a PDF note…"
          value={workspace.draft}
          disabled={!ready}
          onChange={(event) => update({ ...workspace, draft: event.target.value.slice(0, 20_000) })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!busy && ready && connected && (workspace.draft.trim() || attached.length))
                onSend();
            }
          }}
        />
        <div className="chat-notes">{attached.map((note) => noteChip(note, true))}</div>
        <div className="composer-bottom">
          <span className="composer-hint">
            <Paperclip size={16} />
            Mark the PDF to attach feedback
          </span>
          {busy ? (
            <button className="button primary" type="button" onClick={onStop}>
              <Square size={14} />
              Stop
            </button>
          ) : (
            <button
              className="button primary"
              type="submit"
              disabled={!ready || !connected || (!workspace.draft.trim() && !attached.length)}
            >
              Send
              <Send size={15} />
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
