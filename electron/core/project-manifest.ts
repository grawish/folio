export const PROJECT_MANIFEST_LIMIT = 64 * 1024;

// Folder and ZIP opening must recognize the same format. In particular, never
// interpret a future version as this version and replace its unknown metadata.
export function readProjectManifest(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.byteLength > PROJECT_MANIFEST_LIMIT)
    throw new Error('The project manifest exceeds 64 KB. Its files have not been changed.');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(
      'The project manifest could not be read. Keep a copy and repair its UTF-8 JSON before reopening.',
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('The project manifest must be a JSON object. Its files have not been changed.');
  const metadata = value as Record<string, unknown>;
  if (metadata.schemaVersion !== 1 && metadata.schemaVersion !== 2)
    throw new Error(
      'This project format is not supported by this Folio version. Its files have not been changed. Open it with the Folio version that saved it.',
    );
  return metadata;
}
