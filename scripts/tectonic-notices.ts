import { originalNoticeBundle } from './original-notice-bundle';

export const { prepare: prepareTectonicNotices, verify: verifyTectonicNotices } =
  originalNoticeBundle({
    name: 'Tectonic',
    directory: 'tectonic-notices',
    pinFile: 'resources/compiler-build-provenance.lock.json',
    sourceLocks: [
      'resources/runtime-license-sources.lock.json',
      'resources/rust-license-notices.lock.json',
      'resources/rust-standard-library.lock.json',
      'resources/native-license-sources.lock.json',
    ],
    selectPin: (value) => value.compiler,
  });
