export const version = '0.17.0';
export const bundleUrl = 'https://relay.fullyjustified.net/default_bundle_v33.tar';
export const upstreamBundleDigest =
  '6ffe055852f8faf66c0acbe1a7fb27f87b869a90bad1204f3bf4d9683f597c7c';
// Biber must match BibLaTeX 3.17 in the pinned v33 bundle.
export const biber = {
  version: '2.17',
  url: 'https://downloads.sourceforge.net/project/biblatex-biber/biblatex-biber/2.17/binaries/MacOS/biber-darwin_universal.tar.gz',
  archive: 'biber-2.17-darwin-universal.tar.gz',
  hash: '182e1efa074d8a2a23a8893f2a22440d4e463cce55e4ed02076ac4c0ee0614b2',
};
export const releases = {
  'darwin-arm64': {
    triple: 'aarch64-apple-darwin',
    hash: 'a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667',
    os: 'mac',
  },
  'darwin-x64': {
    triple: 'x86_64-apple-darwin',
    hash: '7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80',
    os: 'mac',
  },
  'linux-x64': {
    triple: 'x86_64-unknown-linux-musl',
    hash: '8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7',
    os: 'linux',
  },
  'linux-arm64': {
    triple: 'aarch64-unknown-linux-musl',
    hash: 'b10954a95404f3ab2328d2fa59a5ebab8e657f893fab096f98be8db7c0c979b8',
    os: 'linux',
  },
  'win32-x64': {
    triple: 'x86_64-pc-windows-msvc',
    hash: 'f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f',
    os: 'win',
  },
};
