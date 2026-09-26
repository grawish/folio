import type { PackTrust } from './pack-service';
import publisher from '../../resources/pack-publisher.json';

// Reviewed public configuration is bundled into native code. Renderer settings,
// runtime environment variables and imported archives cannot add trust.
export const packTrust: PackTrust = publisher;
