import path from 'node:path';
import { finalizeDmg } from './dmg-notarization';

const [directory, flag, submissionId, ...extra] = process.argv.slice(2);
if (!directory || extra.length || (flag && (flag !== '--submission-id' || !submissionId)))
  throw new Error('Usage: npm run release:finalize-dmg -- RELEASE_DIR [--submission-id UUID]');
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('Finalize releases on an Apple silicon Mac.');
const result = await finalizeDmg(path.resolve(directory), {
  teamId: process.env.FOLIO_APPLE_TEAM_ID ?? '',
  profile: process.env.APPLE_KEYCHAIN_PROFILE ?? '',
  keychain: process.env.APPLE_KEYCHAIN,
  submissionId,
});
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 2;
