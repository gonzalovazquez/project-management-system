#!/usr/bin/env node
/**
 * Builds the macOS release: one universal (Apple silicon + Intel) app as a .dmg and a .zip.
 *
 * Signing and notarization are driven entirely by environment variables, so no credential ever
 * lives in the repo:
 *
 *   Developer ID signing   CSC_LINK (path or base64 of the .p12) + CSC_KEY_PASSWORD,
 *                          or CSC_NAME (a "Developer ID Application: …" identity in the keychain)
 *   Notarization           APPLE_API_KEY (path to the .p8) + APPLE_API_KEY_ID + APPLE_API_ISSUER,
 *                          or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
 *
 * With no signing credentials it still builds, unsigned, so the pipeline is testable anywhere.
 * An Apple *Development* certificate is never used: it can't be notarized or run on other Macs.
 */
import { spawnSync } from 'node:child_process';

const env = process.env;
const signing = !!(env.CSC_LINK || env.CSC_NAME);
const notarizing = signing && !!((env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) || (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID));

if (env.CSC_NAME && !/^Developer ID Application:/.test(env.CSC_NAME)) {
  console.error(`CSC_NAME must be a "Developer ID Application: …" identity, not "${env.CSC_NAME}".`);
  process.exit(1);
}

const args = ['electron-builder', '--mac', '--universal'];
const childEnv = { ...env };
if (!signing) {
  // Don't let electron-builder pick up whatever certificate happens to be in the keychain. Sign
  // ad hoc ("-") instead: Apple silicon refuses to run code with no signature at all.
  childEnv.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  args.push('-c.mac.identity=-');
  // Ad hoc has no Team ID, so the test build alone relaxes library validation (see the plist).
  args.push('-c.mac.entitlements=build/entitlements.adhoc.plist', '-c.mac.entitlementsInherit=build/entitlements.adhoc.plist');
}
if (notarizing) args.push('-c.mac.notarize=true');

console.log(`PM Workbench release: ${signing ? 'signed with Developer ID' : 'UNSIGNED (no CSC_LINK / CSC_NAME)'}, ${notarizing ? 'notarized' : 'not notarized'}, universal.`);
const r = spawnSync('npx', args, { stdio: 'inherit', env: childEnv });
if (r.status !== 0) process.exit(r.status ?? 1);
if (!signing) console.log('\nUnsigned build: fine for testing; macOS will block it on other Macs. See docs/release.md.');
