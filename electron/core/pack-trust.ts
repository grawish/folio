import type { PackTrust } from './pack-service';

// Replaced only by a reviewed publisher configuration. Renderer settings and
// imported archives cannot add trusted keys or hosts.
export const packTrust: PackTrust = {
  keys: {},
  hosts: ['grawish.com', 'github.com', 'release-assets.githubusercontent.com'],
  minimumSequence: 1,
};
