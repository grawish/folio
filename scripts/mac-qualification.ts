import { inventoryBundle, jsonBytes, sha256 } from './mac-app-inventory';

/** Bind native acceptance to the actual app's bytes, modes and internal links,
 * including code outside app.asar. This does not inventory xattrs or ACLs. */
export async function qualificationIdentity(app: string) {
  const inventory = await inventoryBundle(app);
  const entry = (path: string) => {
    const value = inventory.entries.find((item) => item.path === path);
    if (value?.kind !== 'file' || !value.sha256)
      throw new Error(`Missing qualification identity file: ${path}`);
    return value.sha256;
  };
  return {
    schemaVersion: 1,
    bundleInventorySha256: sha256(jsonBytes(inventory)),
    asarSha256: entry('Contents/Resources/app.asar'),
    runtimeManifestSha256: entry('Contents/Resources/runtime/manifest.json'),
  };
}
