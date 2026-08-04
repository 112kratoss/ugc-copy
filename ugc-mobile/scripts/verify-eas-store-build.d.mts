export interface EasStoreBuildExpectation {
  buildId: string;
  sha: string;
  appVersion: string;
  platform: 'ios' | 'android';
}

export interface VerifiedEasStoreBuild {
  platform: 'ios' | 'android';
  appVersion: string;
  nativeBuildNumber: string;
  buildId: string;
  commitSha: string;
  artifactUrl: string;
}

export function verifyEasStoreBuild(
  build: unknown,
  expected: EasStoreBuildExpectation,
): VerifiedEasStoreBuild;

export function extractEasSubmissionId(output: string): string;
