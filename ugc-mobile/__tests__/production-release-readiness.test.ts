import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  extractEasSubmissionId,
  verifyEasStoreBuild,
} from '../scripts/verify-eas-store-build.mjs';
import { findBundledEnvProblems } from '../scripts/verify-bundled-client-env.mjs';
import { getMissingProductionClientEnv } from '../app.config';

const mobileRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(mobileRoot, '..');

function read(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('mobile production release contracts', () => {
  it('keeps every mobile release manifest aligned to version 0.1.3', () => {
    const appJson = JSON.parse(read('ugc-mobile/app.json'));
    const packageJson = JSON.parse(read('ugc-mobile/package.json'));
    const packageLock = JSON.parse(read('ugc-mobile/package-lock.json'));

    expect(appJson.expo.version).toBe('0.1.3');
    expect(packageJson.version).toBe(appJson.expo.version);
    expect(packageLock.version).toBe(appJson.expo.version);
    expect(packageLock.packages[''].version).toBe(appJson.expo.version);
  });

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
    // The Android store build compiles React Native from source, whose native
    // configure step needs the CMake ReactAndroid pins; the EAS image does not
    // ship it (build 2efa1903 failed on CXX1300 on 2026-09-04), so the
    // post-install hook installs it before Gradle runs.
    expect(packageJson.scripts['eas-build-post-install']).toContain(
      'install-android-cmake.mjs',
    );
    expect(easJson.cli.version).toBe('21.2.0');
    expect(easJson.cli.requireCommit).toBe(true);
    expect(easJson.build.production.env.MAGICBOOKLET_INCLUDE_DEV_CLIENT).toBe('false');
    expect(easJson.submit.staging.android.track).toBe('alpha');
    expect(easJson.submit.staging.android.releaseStatus).toBe('completed');
    expect(validator).toContain('EAS_BUILD_GIT_COMMIT_HASH');
    expect(validator).not.toContain('SENTRY');
  });

  it('refuses every production bundle when public mobile configuration is incomplete', () => {
    const complete = {
      EXPO_PUBLIC_SITE_URL: 'https://magicbooklet.com',
      EXPO_PUBLIC_API_BASE_URL: 'https://magicbooklet.com',
      EXPO_PUBLIC_WEB_API_BASE_URL: 'https://magicbooklet.com',
      EXPO_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
      EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: 'appl_example',
      EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY: 'goog_example',
    };

    expect(getMissingProductionClientEnv(complete)).toEqual([]);
    expect(
      getMissingProductionClientEnv({
        ...complete,
        EXPO_PUBLIC_SUPABASE_URL: '',
        EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY: '   ',
      }),
    ).toEqual([
      'EXPO_PUBLIC_SUPABASE_URL',
      'EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY',
    ]);

    const appConfig = read('ugc-mobile/app.config.ts');
    expect(appConfig).toContain("process.env.NODE_ENV === 'production'");
    expect(appConfig).toContain("process.env.EAS_BUILD_PROFILE === 'production'");
  });

  it('rejects a store artifact whose bundle lost the inlined client configuration', () => {
    const expected = {
      EXPO_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
      EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: 'appl_example',
      EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY: 'goog_example',
    };
    const carriesEverything = Object.values(expected).join(' ');

    expect(findBundledEnvProblems(carriesEverything, expected)).toEqual([]);

    // The shipped 0.1.1 Android bundle: valid, signed, and silently unusable.
    const problems = findBundledEnvProblems('https://magicbooklet.com', expected);
    expect(problems).toHaveLength(4);
    expect(problems[0]).toContain('EXPO_PUBLIC_SUPABASE_URL');
    expect(problems[0]).toContain('not inlined');

    // An expected value we cannot even name is a failure, never a silent pass.
    expect(
      findBundledEnvProblems(carriesEverything, { ...expected, EXPO_PUBLIC_SUPABASE_URL: '  ' }),
    ).toEqual([
      expect.stringContaining('EXPO_PUBLIC_SUPABASE_URL has no expected value'),
    ]);
  });

  it('builds only an exact green main SHA and submits only to protected tester tracks', () => {
    const workflow = read('.github/workflows/mobile-store-release.yml');
    const submitStepStart = workflow.indexOf('- name: Submit to TestFlight or closed alpha');
    const summaryStepStart = workflow.indexOf('- name: Write verified release summary');
    const testerSubmissionStep = workflow.slice(submitStepStart, summaryStepStart);
    const livePrebuildCheck = workflow.indexOf(
      '- name: Verify production serves the authorized commit before build',
    );
    const buildStep = workflow.indexOf('- name: Build signed production artifact');
    const presubmitCheck = workflow.indexOf(
      '- name: Reconfirm main before test-track submission',
    );

    expect(workflow).toContain('actions/workflows/quality.yml/runs?head_sha=');
    expect(workflow).toContain('actions/workflows/production-release.yml/runs?head_sha=');
    expect(workflow).toContain('/api/app-version?release=${EXPECTED_SHA}');
    expect(workflow.match(/body\.buildId !== process\.env\.EXPECTED_SHA/g)).toHaveLength(2);
    expect(workflow).toContain('test "$app_version" = "0.1.3"');
    expect(workflow).toContain('verify-eas-store-build.mjs');
    expect(workflow).toContain('EXPECTED_APP_VERSION');
    expect(workflow).toContain('TESTFLIGHT_INTERNAL_GROUP: ${{ vars.TESTFLIGHT_INTERNAL_GROUP }}');
    expect(workflow).toContain('--groups "$TESTFLIGHT_INTERNAL_GROUP"');
    expect(workflow).toContain('--profile production');
    expect(workflow).toContain('Submit to TestFlight or closed alpha');
    expect(submitStepStart).toBeGreaterThan(-1);
    expect(summaryStepStart).toBeGreaterThan(submitStepStart);
    expect(livePrebuildCheck).toBeGreaterThan(-1);
    expect(buildStep).toBeGreaterThan(livePrebuildCheck);
    expect(presubmitCheck).toBeGreaterThan(buildStep);
    expect(submitStepStart).toBeGreaterThan(presubmitCheck);
    expect(testerSubmissionStep).toContain('--profile staging');
    expect(testerSubmissionStep).not.toContain('--profile production');
    expect(workflow).not.toContain('submit_profile:');
    expect(workflow).toContain('| Platform |');
    expect(workflow).toContain('| App version |');
    expect(workflow).toContain('| Native build number |');
    expect(workflow).toContain('| Build ID |');
    expect(workflow).toContain('| Submission ID |');
    expect(workflow).toContain('| Commit SHA |');
  });

  it('accepts only a finished signed store artifact for the exact build inputs', () => {
    const sha = 'a'.repeat(40);
    const verified = verifyEasStoreBuild(
      {
        id: 'build-id',
        status: 'FINISHED',
        platform: 'IOS',
        gitCommitHash: sha,
        appVersion: '0.0.5',
        appBuildVersion: '27',
        buildProfile: 'production',
        distribution: 'STORE',
        isForIosSimulator: false,
        completedAt: '2026-08-04T12:00:00.000Z',
        artifacts: {
          buildUrl: 'https://expo.dev/artifacts/eas/example.ipa',
        },
      },
      {
        buildId: 'build-id',
        sha,
        appVersion: '0.0.5',
        platform: 'ios',
      },
    );

    expect(verified).toMatchObject({
      platform: 'ios',
      appVersion: '0.0.5',
      nativeBuildNumber: '27',
      buildId: 'build-id',
      commitSha: sha,
    });
  });

  it.each([
    ['wrong commit', { gitCommitHash: 'b'.repeat(40) }, 'SHA mismatch'],
    ['wrong version', { appVersion: '0.0.4' }, 'app version mismatch'],
    ['unfinished build', { status: 'IN_PROGRESS' }, 'not finished'],
    ['internal artifact', { distribution: 'INTERNAL' }, 'not a signed store distribution'],
    ['missing artifact', { artifacts: {} }, 'store artifact URL is missing'],
  ])('rejects %s metadata before submission', (_name, override, error) => {
    const sha = 'a'.repeat(40);
    const build = {
      id: 'build-id',
      status: 'FINISHED',
      platform: 'ANDROID',
      gitCommitHash: sha,
      appVersion: '0.0.5',
      appBuildVersion: '39',
      buildProfile: 'production',
      distribution: 'STORE',
      completedAt: '2026-08-04T12:00:00.000Z',
      artifacts: {
        buildUrl: 'https://expo.dev/artifacts/eas/example.aab',
      },
      ...override,
    };

    expect(() => verifyEasStoreBuild(build, {
      buildId: 'build-id',
      sha,
      appVersion: '0.0.5',
      platform: 'android',
    })).toThrow(error);
  });

  it('extracts the EAS submission ID used in the release summary', () => {
    const id = '12345678-1234-4abc-8def-123456789abc';
    const output = `Submission details: https://expo.dev/accounts/team/projects/app/submissions/${id}`;

    expect(extractEasSubmissionId(output)).toBe(id);
    expect(() => extractEasSubmissionId('submission did not start')).toThrow(
      'did not contain a submission ID',
    );
  });
});
