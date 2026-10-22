import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = join(__dirname, '..');
const fileName = 'fingerprint.config.js';
const parkedAt = join('experiments/fingerprint-dev-only', fileName);

/**
 * expo-dev-client and the modules it brings are hashed into the runtime
 * fingerprint though production builds never link them, so each of their
 * patches strands over-the-air updates. The config that leaves them out moves
 * both fingerprints once, so it waits in experiments/fingerprint-dev-only/
 * (its README) for the next store build, where @expo/fingerprint does not
 * read it.
 */
describe('development-only modules out of the fingerprint', () => {
  const read = (relativePath: string) => readFileSync(join(projectRoot, relativePath), 'utf8');
  const shipped = existsSync(join(projectRoot, fileName));
  const parked = existsSync(join(projectRoot, parkedAt));

  it('lives in one place: parked in experiments/, or beside app.json', () => {
    expect([shipped, parked].filter(Boolean)).toHaveLength(1);
  });

  it('is still parked only because 0.1.8 is the newest store build', () => {
    // The next store build is cut from a release bump. Move the file beside
    // app.json in that commit (README, "Graduating"), so both binaries carry
    // the fingerprint it gives. A release that ships one platform repins this.
    if (parked) {
      expect(JSON.parse(read('app.json')).expo.version).toBe('0.1.8');
    }
  });

  it('takes its list from the plugin that keeps those modules out of production builds', () => {
    const config = read(shipped ? fileName : parkedAt);
    expect(config).toContain("require('./plugins/withBuildProfileAutolinking')");
    expect(config).toContain('DEVELOPMENT_ONLY_NATIVE_MODULES');
  });
});
