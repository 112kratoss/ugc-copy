#!/usr/bin/env node

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const PLATFORM_NAMES = {
  android: 'ANDROID',
  ios: 'IOS',
};

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is missing`);
  }
  return value.trim();
}

function requireHttpsUrl(value, label) {
  const raw = requireNonEmptyString(value, label);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${label} must use HTTPS`);
  }
  return raw;
}

/**
 * Fail closed unless EAS describes a finished, signed store artifact produced
 * from the exact release revision and application version requested by CI.
 */
export function verifyEasStoreBuild(build, expected) {
  if (!build || typeof build !== 'object' || Array.isArray(build)) {
    throw new Error('EAS build metadata must be an object');
  }

  const expectedId = requireNonEmptyString(expected?.buildId, 'expected build ID');
  const expectedSha = requireNonEmptyString(expected?.sha, 'expected Git SHA');
  const expectedAppVersion = requireNonEmptyString(
    expected?.appVersion,
    'expected app version',
  );
  const expectedPlatformName = PLATFORM_NAMES[expected?.platform];
  if (!expectedPlatformName) {
    throw new Error(`unsupported expected platform: ${expected?.platform ?? 'missing'}`);
  }

  if (build.id !== expectedId) {
    throw new Error(
      `EAS build ID mismatch: expected ${expectedId}, received ${build.id ?? 'missing'}`,
    );
  }
  if (build.status !== 'FINISHED') {
    throw new Error(`EAS build is not finished: ${build.status ?? 'missing'}`);
  }
  if (build.platform !== expectedPlatformName) {
    throw new Error(
      `EAS build platform mismatch: expected ${expectedPlatformName}, received ${build.platform ?? 'missing'}`,
    );
  }
  if (build.gitCommitHash !== expectedSha) {
    throw new Error(
      `EAS build SHA mismatch: expected ${expectedSha}, received ${build.gitCommitHash ?? 'missing'}`,
    );
  }
  if (build.appVersion !== expectedAppVersion) {
    throw new Error(
      `EAS app version mismatch: expected ${expectedAppVersion}, received ${build.appVersion ?? 'missing'}`,
    );
  }
  if (build.buildProfile !== 'production') {
    throw new Error(
      `EAS build profile is not production: ${build.buildProfile ?? 'missing'}`,
    );
  }
  if (build.distribution !== 'STORE') {
    throw new Error(
      `EAS artifact is not a signed store distribution: ${build.distribution ?? 'missing'}`,
    );
  }
  if (expected.platform === 'ios' && build.isForIosSimulator !== false) {
    throw new Error('EAS iOS artifact must be a signed device build, not a simulator build');
  }

  const nativeBuildNumber = requireNonEmptyString(
    String(build.appBuildVersion ?? ''),
    'EAS native build number',
  );
  const artifactUrl = requireHttpsUrl(build.artifacts?.buildUrl, 'EAS store artifact URL');
  const completedAt = requireNonEmptyString(build.completedAt, 'EAS completion timestamp');
  if (Number.isNaN(Date.parse(completedAt))) {
    throw new Error('EAS completion timestamp is invalid');
  }

  return {
    platform: expected.platform,
    appVersion: build.appVersion,
    nativeBuildNumber,
    buildId: build.id,
    commitSha: build.gitCommitHash,
    artifactUrl,
  };
}

export function extractEasSubmissionId(output) {
  if (typeof output !== 'string') {
    throw new Error('EAS submission output must be text');
  }

  const ids = new Set(
    [...output.matchAll(
      /\/submissions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f-])/gi,
    )]
      .map((match) => match[1].toLowerCase()),
  );
  if (ids.size === 0) {
    throw new Error('EAS submission output did not contain a submission ID');
  }
  if (ids.size !== 1) {
    throw new Error('EAS submission output contained multiple submission IDs');
  }
  return [...ids][0];
}

function requireEnv(name) {
  return requireNonEmptyString(process.env[name], name);
}

function appendGitHubOutput(values) {
  const outputPath = requireEnv('GITHUB_OUTPUT');
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join('');
  fs.appendFileSync(outputPath, lines);
}

function runCli() {
  if (process.argv.includes('--submission')) {
    const output = fs.readFileSync(requireEnv('SUBMISSION_LOG_PATH'), 'utf8');
    appendGitHubOutput({ submission_id: extractEasSubmissionId(output) });
    return;
  }

  const build = JSON.parse(fs.readFileSync(requireEnv('VIEW_PATH'), 'utf8'));
  const verified = verifyEasStoreBuild(build, {
    buildId: requireEnv('EXPECTED_BUILD_ID'),
    sha: requireEnv('EXPECTED_SHA'),
    appVersion: requireEnv('EXPECTED_APP_VERSION'),
    platform: requireEnv('EXPECTED_PLATFORM'),
  });
  appendGitHubOutput({
    platform: verified.platform,
    app_version: verified.appVersion,
    native_build_number: verified.nativeBuildNumber,
    build_id: verified.buildId,
    commit_sha: verified.commitSha,
    artifact_url: verified.artifactUrl,
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  runCli();
}
