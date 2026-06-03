// Fails the build early with a clear message if signing/notarization isn't set up,
// so you don't discover it 8 minutes into a build the night before a client install.
import { execSync } from 'node:child_process';

const need = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
const missing = need.filter((k) => !process.env[k]);

let hasDevId = false;
try {
  const out = execSync('security find-identity -v -p codesigning', { encoding: 'utf8' });
  hasDevId = /Developer ID Application/.test(out);
} catch { /* ignore */ }

const problems = [];
if (!hasDevId) problems.push('No "Developer ID Application" certificate in keychain. See SHIP.md step 1.');
if (missing.length) problems.push(`Missing env vars: ${missing.join(', ')}. See SHIP.md step 4.`);

if (problems.length) {
  console.error('\n✗ Pre-flight failed — signed build cannot proceed:\n');
  for (const p of problems) console.error('  • ' + p);
  console.error('\nTo build an UNSIGNED .dmg anyway (Gatekeeper bypass needed on install):');
  console.error('  npm run build:mac\n');
  process.exit(1);
}
console.log('✓ Pre-flight OK — Developer ID cert present, notarization env set. Building…');
