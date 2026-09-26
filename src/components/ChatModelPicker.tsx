import { useEffect, useState } from 'react';
import { Settings2 } from 'lucide-react';
import type { AIConnection, AISettings, ModelCatalog, ModelSelection } from '../shared/ai';

export function ChatModelPicker({
  connection,
  disabled,
  onChange,
  onBusy,
  onSettings,
}: {
  connection?: AIConnection;
  disabled: boolean;
  onChange(settings: AISettings): void;
  onBusy(busy: boolean): void;
  onSettings(): void;
}) {
  const [catalog, setCatalog] = useState<ModelCatalog>({ models: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setCatalog({ models: [] });
    setError('');
    if (!connection || !window.folio) return;
    setLoading(true);
    void window.folio
      .getAIModels(connection.id)
      .then((result) => {
        if (alive) setCatalog(result);
      })
      .catch(() => {
        if (alive) setError('Model discovery is unavailable. Configured models remain usable.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [connection]);
  if (!connection) return null;
  const selection = connection.selection ?? { mode: 'default' };
  const selected = selection.mode === 'manual' ? `model:${selection.model}` : selection.mode;
  const models = [...catalog.models];
  for (const id of [
    connection.model,
    connection.autoModels?.fast,
    connection.autoModels?.capable,
    selection.model,
  ])
    if (id && !models.some((m) => m.id === id)) models.push({ id, name: id });
  const choose = async (value: string) => {
    if (!window.folio) return;
    const next: ModelSelection = value.startsWith('model:')
      ? { mode: 'manual', model: value.slice(6) }
      : { mode: value as 'auto' | 'default' };
    onBusy(true);
    setError('');
    try {
      onChange(await window.folio.selectAIModel(connection.id, next));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      onBusy(false);
    }
  };
  return (
    <div className="chat-model-control">
      <div className="chat-model-row">
        <button
          type="button"
          className="chat-connection-button"
          onClick={onSettings}
          title="AI connection settings"
        >
          <Settings2 size={14} />
          <span>{connection.name}</span>
        </button>
        <select
          aria-label="Chat model"
          value={selected}
          disabled={disabled}
          onChange={(event) => void choose(event.target.value)}
        >
          <option value="auto">Auto</option>
          <option value="default">
            Connection default{connection.model ? ` · ${connection.model}` : ''}
          </option>
          {models.map((model) => (
            <option key={model.id} value={`model:${model.id}`}>
              {model.name}
            </option>
          ))}
        </select>
      </div>
      {(error || catalog.warning) && <small aria-live="polite">{error || catalog.warning}</small>}
      {loading && <small aria-live="polite">Loading models…</small>}
    </div>
  );
}
