import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { REQUIRED_PRODUCTION_CLIENT_ENV as REQUIRED_BY_APP_CONFIG } from '../app.config';
import {
  FORBIDDEN_BUNDLE_STRINGS,
  hermesDebugInfoBytes,
  inspectBundle,
  latestUpdatePerPlatform,
  MAX_DEBUG_INFO_BYTES,
  parseArgs,
  REQUIRED_PRODUCTION_CLIENT_ENV,
  setAsideFor,
  shellQuote,
  sourceCommitCandidates,
  formatMessage,
} from '../scripts/publish-ota.mjs';

const mobileRoot = path.resolve(__dirname, '..');
const SHA = '0123456789abcdef0123456789abcdef01234567';

// A minimal Hermes v96 file: magic, version, fileLength @32, debugInfoOffset @104.
function hermesBundle({ version = 96, debugInfo = 48, body = '' }: { version?: number; debugInfo?: number; body?: string } = {}) {
  const headerSize = 128;
  const content = Buffer.from(body, 'latin1');
  const fileLength = headerSize + content.length + debugInfo;
  const bytes = Buffer.alloc(fileLength);
  bytes.writeUInt32LE(0x03bc1fc6, 0);
  bytes.writeUInt32LE(0x1f1903c1, 4);
  bytes.writeUInt32LE(version, 8);
  bytes.writeUInt32LE(fileLength, 32);
  bytes.writeUInt32LE(fileLength - debugInfo, 104);
  content.copy(bytes, headerSize);
  return bytes;
}

const productionEnv = Object.fromEntries(
  REQUIRED_PRODUCTION_CLIENT_ENV.map((name, index) => [name, `value-${index}-${name.toLowerCase()}`]),
);
const inlinedValues = Object.values(productionEnv).join('\n');

describe('publish-ota arguments', () => {
  it('is a dry run against origin/main unless told otherwise', () => {
    expect(parseArgs(['--platform', 'all'])).toMatchObject({
      platforms: ['ios', 'android'],
      ref: 'origin/main',
      publish: false,
      allowRollback: false,
      allowRepublish: false,
      rollout: null,
    });
  });

  it('rejects what would make a publish ambiguous', () => {
    expect(() => parseArgs([])).toThrow(/--platform is required/);
    expect(() => parseArgs(['--platform', 'web'])).toThrow(/ios, android, or all/);
    for (const rollout of ['0', '101', '12.5', 'half']) {
      expect(() => parseArgs(['--platform', 'ios', '--rollout', rollout])).toThrow(/whole percentage/);
    }
    expect(() => parseArgs(['--platform', 'ios', '--dry'])).toThrow(/Unrecognised argument/);
    expect(() => parseArgs(['--platform', 'ios', '--ref'])).toThrow(/needs a value/);
  });

  it('only accepts ASCII markers, because Hermes stores other text as UTF-16', () => {
    expect(parseArgs(['--platform', 'ios', '--expect', 'Could not mark startup interactive']).expect)
      .toEqual(['Could not mark startup interactive']);
    expect(() => parseArgs(['--platform', 'ios', '--expect', 'Signing out…'])).toThrow(/printable ASCII/);
  });
});

describe('set-aside files', () => {
  it('reads a target list and keeps it inside ugc-mobile', () => {
    expect(setAsideFor({}, 'ios')).toEqual([]);
    expect(setAsideFor({ android: { setAside: ['patches/a.patch'] } }, 'android')).toEqual(['patches/a.patch']);
    for (const entry of ['../app.json', '/etc/hosts', '']) {
      expect(() => setAsideFor({ android: { setAside: [entry] } }, 'android')).toThrow(/inside ugc-mobile/);
    }
  });

  it('names only files that exist, so a renamed patch cannot silently stop matching', () => {
    const { targets } = JSON.parse(readFileSync(path.join(mobileRoot, 'ota-targets.json'), 'utf8'));
    for (const platform of ['ios', 'android'] as const) {
      for (const file of setAsideFor(targets, platform)) {
        expect(existsSync(path.join(mobileRoot, file)), `${platform}: ${file}`).toBe(true);
      }
    }
  });
});

describe('the rollback guard', () => {
  it('tags each update with its full source commit and reads it back', () => {
    const listed = `"${formatMessage('Ship the feed cache', SHA)}" (2 hours ago by athulsiva)`;
    expect(sourceCommitCandidates(listed)).toEqual([SHA]);
    expect(() => formatMessage('x', 'b34d483')).toThrow(/full commit SHA/);
  });

  it('falls back to short SHAs in older messages, never to plain numbers', () => {
    expect(sourceCommitCandidates('"Cut the mobile bundle by 29% (#152, b34d483)" (24 minutes ago by athulsiva)'))
      .toEqual(['b34d483']);
    expect(sourceCommitCandidates('Built from workflow run 33969667328')).toEqual([]);
  });

  it('takes the newest update per platform from a newest-first listing', () => {
    const latest = latestUpdatePerPlatform([
      { platforms: 'android', group: 'android-new' },
      { platforms: 'ios', group: 'ios-new' },
      { platforms: 'android', group: 'android-old' },
      { platforms: 'android, ios', group: 'both-older' },
    ]);
    expect(latest.android?.group).toBe('android-new');
    expect(latest.ios?.group).toBe('ios-new');
  });
});

describe('artifact checks', () => {
  it('reads the embedded debug info from the header', () => {
    expect(hermesDebugInfoBytes(hermesBundle({ debugInfo: 48 }))).toBe(48);
    expect(hermesDebugInfoBytes(hermesBundle({ debugInfo: 2_522_555 }))).toBe(2_522_555);
    expect(hermesDebugInfoBytes(hermesBundle({ version: 97 }))).toBeNull();
    expect(hermesDebugInfoBytes(Buffer.from('var __BUNDLE_START_TIME__=Date.now();'.padEnd(200)))).toBeUndefined();
  });

  it('passes a lean bundle that inlines every production value', () => {
    const results = inspectBundle({
      bytes: hermesBundle({ body: `${inlinedValues}\nCould not mark startup interactive` }),
      hasSourceMap: true,
      env: productionEnv,
      expect: ['Could not mark startup interactive'],
    });
    expect(results.filter((result) => !result.ok)).toEqual([]);
    expect(results).toHaveLength(2 + REQUIRED_PRODUCTION_CLIENT_ENV.length + FORBIDDEN_BUNDLE_STRINGS.length + 1);
  });

  it('fails the -g1 export the old recipe shipped', () => {
    const results = inspectBundle({
      bytes: hermesBundle({ body: inlinedValues, debugInfo: MAX_DEBUG_INFO_BYTES + 2_500_000 }),
      hasSourceMap: false,
      env: productionEnv,
    });
    expect(results.filter((result) => !result.ok).map((result) => result.label)).toEqual([
      expect.stringMatching(/^source map written/),
      expect.stringMatching(/^embedded debug info \d+ bytes/),
    ]);
  });

  it('fails a bundle built from local or placeholder values, without printing any value', () => {
    const { EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: _dropped, ...withoutRevenueCatIos } = productionEnv;
    const body = `${Object.values(withoutRevenueCatIos).join('\n')}\nci-placeholder`;
    const results = inspectBundle({ bytes: hermesBundle({ body }), hasSourceMap: true, env: productionEnv });
    const failed = results.filter((result) => !result.ok).map((result) => result.label);

    expect(failed).toEqual([
      expect.stringMatching(/^EXPO_PUBLIC_REVENUECAT_IOS_API_KEY inlined/),
      'absent: ci-placeholder',
    ]);
    for (const { label } of results) {
      for (const value of Object.values(productionEnv)) expect(label).not.toContain(value);
    }
  });

  it('fails anything that is not Hermes bytecode, and an empty production value', () => {
    const results = inspectBundle({
      bytes: Buffer.from(inlinedValues.padEnd(400)),
      hasSourceMap: true,
      env: { ...productionEnv, EXPO_PUBLIC_SITE_URL: '' },
    });
    const failed = results.filter((result) => !result.ok).map((result) => result.label);
    expect(failed).toContain('bundle is Hermes bytecode');
    expect(failed).toContain('EXPO_PUBLIC_SITE_URL inlined (prefix ∅…, length 0)');
  });
});

describe('publish-ota wiring', () => {
  it('checks the same production variables the app config guards', () => {
    expect(REQUIRED_PRODUCTION_CLIENT_ENV).toEqual([...REQUIRED_BY_APP_CONFIG]);
  });

  it('quotes paths for the env:exec shell, spaces and quotes included', () => {
    const tricky = "/Users/athuls/UGC copy/it's here";
    expect(execFileSync('sh', ['-c', `printf %s ${shellQuote(tricky)}`], { encoding: 'utf8' })).toBe(tricky);
  });

  it('stays out of package.json, which is a fingerprint input in full', () => {
    const { scripts } = JSON.parse(readFileSync(path.join(mobileRoot, 'package.json'), 'utf8'));
    expect(JSON.stringify(scripts)).not.toContain('publish-ota');
  });
});
