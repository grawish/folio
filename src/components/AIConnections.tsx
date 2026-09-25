import { useState } from 'react';
import { ArrowLeft, CheckCircle2, LoaderCircle, Plus, Settings2, Trash2 } from 'lucide-react';
import type { AISettings, ConnectionInput, ConnectionStatus, ProviderKind } from '../shared/ai';

const names: Record<ProviderKind, string> = {
  codex: 'Codex subscription',
  'claude-code': 'Claude Code subscription',
  openai: 'OpenAI API key',
  anthropic: 'Anthropic API key',
  custom: 'Custom API connection',
};
export function AIConnections({
  settings,
  onChange,
}: {
  settings: AISettings;
  onChange(settings: AISettings): void;
}) {
  const [form, setForm] = useState<ConnectionInput | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({});
  const native = form?.kind === 'codex' || form?.kind === 'claude-code';
  const act = async (operation: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try {
      await operation();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const update = (patch: Partial<ConnectionInput>) =>
    setForm((value) => (value ? { ...value, ...patch } : value));
  if (!window.folio)
    return (
      <div className="settings-content">
        <h3>AI connections</h3>
        <p>Open the desktop app to connect a subscription or add your API key.</p>
      </div>
    );
  const desktop = window.folio;
  return (
    <div className="settings-content ai-settings">
      {form ? (
        <>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => {
              setForm(null);
              setMessage('');
            }}
          >
            <ArrowLeft size={14} />
            Back to connections
          </button>
          <h3>{form.id ? 'Edit connection' : 'Add connection'}</h3>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                onChange(await desktop.saveAIConnection(form));
                setForm(null);
                setMessage('Connection saved. Select it below to use it for new messages.');
              });
            }}
          >
            <label className="ai-field">
              Connection type
              <select
                aria-label="Connection type"
                value={form.kind}
                disabled={busy}
                onChange={(event) =>
                  update({
                    kind: event.target.value as ProviderKind,
                    model: '',
                    baseUrl: '',
                    apiKey: '',
                    executable: '',
                    format: 'chat-completions',
                  })
                }
              >
                {Object.entries(names).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="ai-field">
              Connection name
              <input
                className="text-input"
                required
                maxLength={80}
                value={form.name}
                onChange={(event) => update({ name: event.target.value })}
              />
            </label>
            {native ? (
              <>
                <p className="settings-hint">
                  Use your existing subscription through its installed app. After saving, choose
                  Sign in or Check connection.
                </p>
                <label className="ai-field">
                  App location <small>Optional; leave blank to find the installed command.</small>
                  <input
                    className="text-input"
                    value={form.executable ?? ''}
                    placeholder={form.kind === 'codex' ? '/path/to/codex' : '/path/to/claude'}
                    onChange={(event) => update({ executable: event.target.value })}
                  />
                </label>
              </>
            ) : (
              <>
                {form.kind === 'custom' && (
                  <>
                    <label className="ai-field">
                      API format
                      <select
                        value={form.format}
                        onChange={(event) =>
                          update({ format: event.target.value as ConnectionInput['format'] })
                        }
                      >
                        <option value="chat-completions">OpenAI Chat Completions compatible</option>
                        <option value="responses">OpenAI Responses compatible</option>
                        <option value="anthropic">Anthropic Messages compatible</option>
                      </select>
                    </label>
                    <label className="ai-field">
                      Base URL
                      <input
                        type="url"
                        className="text-input"
                        required
                        value={form.baseUrl ?? ''}
                        placeholder="https://ai.example.com/v1"
                        onChange={(event) => update({ baseUrl: event.target.value })}
                      />
                    </label>
                  </>
                )}
                <label className="ai-field">
                  API key {form.kind === 'custom' ? '(optional)' : ''}
                  <input
                    className="text-input"
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    value={form.apiKey ?? ''}
                    placeholder={
                      form.id ? 'Leave blank to keep the saved key' : 'Enter your own key'
                    }
                    onChange={(event) => update({ apiKey: event.target.value })}
                  />
                </label>
                {form.kind === 'custom' && form.id && (
                  <label className="check-line">
                    <input
                      type="checkbox"
                      checked={form.clearKey ?? false}
                      onChange={(event) => update({ clearKey: event.target.checked })}
                    />
                    Remove the saved key
                  </label>
                )}
                <p className="settings-hint">
                  Keys use protected storage on this device. Your provider bills API use separately.
                </p>
              </>
            )}
            <label className="ai-field">
              Model
              <input
                className="text-input"
                list="connection-models"
                required={!native}
                value={form.model}
                placeholder={
                  native ? 'Default for this account' : 'Enter an image-capable model ID'
                }
                onChange={(event) => update({ model: event.target.value })}
              />
              <datalist id="connection-models">
                {form.id &&
                  statuses[form.id]?.models?.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
              </datalist>
            </label>
            <div className="modal-actions">
              <button
                className="button secondary"
                type="button"
                disabled={busy}
                onClick={() => setForm(null)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy} type="submit">
                {busy && <LoaderCircle size={14} className="spin" />}Save connection
              </button>
            </div>
          </form>
        </>
      ) : (
        <>
          <h3>AI connections</h3>
          <p className="settings-hint">
            Choose the AI used for your chats. Changes apply to your next message.
          </p>
          <div className="connection-list" role="radiogroup" aria-label="Active AI connection">
            {!settings.connections.length && (
              <p>No connections yet. Add a subscription or your own API key.</p>
            )}
            {settings.connections.map((connection) => (
              <div
                className={`connection-row ${settings.activeId === connection.id ? 'selected' : ''}`}
                key={connection.id}
              >
                <label>
                  <input
                    type="radio"
                    name="active-connection"
                    checked={settings.activeId === connection.id}
                    disabled={busy}
                    onChange={() =>
                      void act(async () =>
                        onChange(await desktop.selectAIConnection(connection.id)),
                      )
                    }
                  />
                  <span>
                    <strong>{connection.name}</strong>
                    <small>
                      {names[connection.kind]} · {connection.model || 'Account default'}
                    </small>
                  </span>
                </label>
                <button
                  className="icon-button"
                  aria-label={`Edit ${connection.name}`}
                  disabled={busy}
                  onClick={() => setForm({ ...connection, apiKey: '' })}
                >
                  <Settings2 size={16} />
                </button>
              </div>
            ))}
          </div>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => {
              setMessage('');
              setForm({ name: '', kind: 'codex', model: '' });
            }}
          >
            <Plus size={15} />
            Add connection
          </button>
          {settings.connections.map(
            (connection) =>
              settings.activeId === connection.id && (
                <section className="selected-connection" key={connection.id}>
                  <h4>Selected connection</h4>
                  <p>
                    {connection.name} · {connection.model || 'Default for this account'}
                  </p>
                  {connection.vision === 'verified' && (
                    <p className="connection-ok">
                      <CheckCircle2 size={15} />
                      Image support verified
                    </p>
                  )}
                  {statuses[connection.id] && (
                    <p role="status">{statuses[connection.id].message}</p>
                  )}
                  <div className="connection-actions">
                    <button
                      className="button secondary small"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          const status = await desktop.checkAIConnection(connection.id);
                          setStatuses((value) => ({ ...value, [connection.id]: status }));
                        })
                      }
                    >
                      Check connection
                    </button>
                    <button
                      className="button secondary small"
                      disabled={busy}
                      title="Sends a small test image; provider usage may apply."
                      onClick={() =>
                        void act(async () => {
                          const status = await desktop.checkAIConnection(connection.id, true);
                          setStatuses((value) => ({ ...value, [connection.id]: status }));
                          onChange(await desktop.getAISettings());
                        })
                      }
                    >
                      Test image support
                    </button>
                    {(connection.kind === 'codex' || connection.kind === 'claude-code') && (
                      <>
                        <button
                          className="button secondary small"
                          disabled={busy}
                          onClick={() =>
                            void act(async () =>
                              setMessage((await desktop.loginAIConnection(connection.id)).message),
                            )
                          }
                        >
                          Sign in
                        </button>
                        <button
                          className="text-button"
                          onClick={() =>
                            void act(async () => {
                              await desktop.cancelAILogin(connection.id);
                              setMessage('Sign-in cancelled.');
                            })
                          }
                        >
                          Cancel sign-in
                        </button>
                      </>
                    )}
                  </div>
                  <p className="settings-hint">
                    The image test sends a small sample, not your resume. Normal provider usage may
                    apply.
                  </p>
                  <button
                    className="text-button remove-connection"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        onChange(await desktop.removeAIConnection(connection.id));
                        setMessage(
                          'Removed from Folio. Subscription sign-in in the local app stays unchanged.',
                        );
                      })
                    }
                  >
                    <Trash2 size={14} />
                    Remove connection from Folio
                  </button>
                </section>
              ),
          )}
        </>
      )}
      {busy && (
        <p className="settings-hint" role="status">
          <LoaderCircle size={14} className="spin" />
          Working…
        </p>
      )}
      {message && (
        <p className="connection-message" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
