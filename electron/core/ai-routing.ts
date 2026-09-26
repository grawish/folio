import type { AIConnection, ModelDescriptor, ModelSelection } from '../../src/shared/ai';

export function validateSelection(value: unknown): ModelSelection {
  const s = value as ModelSelection;
  if (
    !s ||
    !['auto', 'default', 'manual'].includes(s.mode) ||
    (s.mode === 'manual' &&
      (typeof s.model !== 'string' || !s.model.trim() || s.model.length > 160))
  )
    throw new Error('Choose Auto, the connection default, or a model.');
  return s.mode === 'manual' ? { mode: s.mode, model: s.model!.trim() } : { mode: s.mode };
}

export type TaskKind = 'text' | 'question' | 'visual';
export function classifyTask(message: string, noteCount: number): TaskKind {
  if (
    noteCount ||
    /\b(layout|spacing|margin|font|page|fit|design|template|columns?|overlap|clip|review|rewrite|restructure|reorganize|format|visual|pdf|broken|compile|error)\b/i.test(
      message,
    )
  )
    return 'visual';
  if (/^(what|why|how|where|explain|can you explain|tell me)\b/i.test(message)) return 'question';
  if (
    message.length <= 600 &&
    /\b(typo|spelling|wording|rename|replace|change .{1,120} to |correct .{1,120} to )/i.test(
      message,
    )
  )
    return 'text';
  return 'visual';
}

export function knownModel(id: string): Partial<ModelDescriptor> {
  if (/^gpt-(?:6-(?:luna|sol|astra)|5\.6-(?:luna|sol|terra))$/.test(id))
    return { images: true, efforts: ['low', 'medium', 'high'] };
  if (/^gpt-5\.4(?:-mini)?$/.test(id)) return { images: true, efforts: ['low', 'medium', 'high'] };
  if (/^(haiku|sonnet|opus)$/.test(id) || /^claude-(haiku|sonnet|opus)-/.test(id))
    return { images: true };
  return {};
}

export function resolveModel(
  profile: AIConnection,
  selection: ModelSelection,
  models: ModelDescriptor[],
  capable: boolean,
): ModelDescriptor {
  let id = profile.model;
  if (selection.mode === 'manual') id = selection.model!;
  if (selection.mode === 'auto') {
    if (capable)
      id =
        profile.autoModels?.capable ||
        profile.model ||
        (profile.kind === 'claude-code' ? 'sonnet' : models.find((m) => m.isDefault)?.id || '');
    else {
      const fast =
        profile.kind === 'custom'
          ? profile.model
          : profile.kind === 'claude-code'
            ? 'haiku'
            : profile.kind === 'anthropic'
              ? models.find((m) => /^claude-haiku-/.test(m.id))?.id
              : ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.4-mini'].find((id) =>
                  models.some((m) => m.id === id),
                );
      id =
        profile.autoModels?.fast ||
        fast ||
        profile.model ||
        models.find((m) => m.isDefault)?.id ||
        '';
    }
  }
  return (
    models.find((m) => m.id === id) ?? {
      id,
      name: id || 'Account default',
      ...(profile.kind === 'custom' ? {} : knownModel(id)),
      ...(id === profile.model && profile.vision === 'verified' ? { images: true } : {}),
    }
  );
}

export function modelEffort(model: ModelDescriptor, requested: 'low' | 'medium' | 'high') {
  if (!model.efforts?.length) return undefined;
  return model.efforts.includes(requested)
    ? requested
    : ['medium', 'low', 'high'].find((value) => model.efforts!.includes(value));
}
