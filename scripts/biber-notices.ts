import { originalNoticeBundle } from './original-notice-bundle';

export const { prepare: prepareBiberNotices, verify: verifyBiberNotices } = originalNoticeBundle({
  name: 'Biber',
  directory: 'biber-notices',
  pinFile: 'resources/biber-build-provenance.lock.json',
  sourceLocks: [
    'resources/runtime-license-sources.lock.json',
    'resources/biber-build-provenance.lock.json',
    'resources/biber-cpan-sources.lock.json',
    'resources/biber-native-sources.lock.json',
  ],
  selectPin: (value) => ({
    version: value.biberVersion,
    sourceCommit: value.sourceCommit,
    binarySha256: value.arm64Binary.sha256,
  }),
});
