import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const mobileRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(mobileRoot, '..');

function read(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('mobile production release contracts', () => {
  it('uses store-native crash reporting without requiring Sentry configuration', () => {
    const packageJson = JSON.parse(read('ugc-mobile/package.json'));
    const appJson = JSON.parse(read('ugc-mobile/app.json'));
    const metroConfig = read('ugc-mobile/metro.config.js');
    const layout = read('ugc-mobile/app/_layout.tsx');
    const readme = read('ugc-mobile/README.md');

    expect(packageJson.dependencies['@sentry/react-native']).toBeUndefined();
    expect(appJson.expo.plugins).not.toContain('@sentry/react-native/expo');
    expect(metroConfig).not.toContain('Sentry');
    expect(layout).not.toContain('Sentry');
    expect(readme).toContain('App Store Connect');
    expect(readme).toContain('Google Play Console');
  });

  it('fails closed on production EAS inputs and pins the release tooling', () => {
    const packageJson = JSON.parse(read('ugc-mobile/package.json'));
    const easJson = JSON.parse(read('ugc-mobile/eas.json'));
    const validator = read('ugc-mobile/scripts/verify-production-build-env.mjs');

    expect(packageJson.scripts['eas-build-pre-install']).toContain(
      'verify-production-build-env.mjs',
    );
    expect(easJson.cli.version).toBe('21.2.0');
    expect(easJson.cli.requireCommit).toBe(true);
    expect(easJson.build.production.env.MAGICBOOKLET_INCLUDE_DEV_CLIENT).toBe('false');
    expect(easJson.submit.staging.android.track).toBe('alpha');
    expect(validator).toContain('EAS_BUILD_GIT_COMMIT_HASH');
    expect(validator).not.toContain('SENTRY');
  });

  it('builds only an exact green main SHA and cannot submit directly to public production', () => {
    const workflow = read('.github/workflows/mobile-store-release.yml');

    expect(workflow).toContain('actions/workflows/quality.yml/runs?head_sha=');
    expect(workflow).toContain('gitCommitHash');
    expect(workflow).toContain('--profile production');
    expect(workflow).toContain('--profile staging');
    expect(workflow).not.toContain('submit \\\n            --profile production');
    expect(workflow).toContain('Submit to TestFlight or closed alpha');
  });
});
