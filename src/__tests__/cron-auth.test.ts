import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isAuthorizedCronRequest,
  isAuthorizedOpsRequest,
} from '@/lib/cron-auth';

const originalCronSecret = process.env.CRON_SECRET;
const originalCronSecretPrevious = process.env.CRON_SECRET_PREVIOUS;
const originalOpsReadSecret = process.env.OPS_READ_SECRET;
const originalOpsReadSecretPrevious = process.env.OPS_READ_SECRET_PREVIOUS;
const sourcePath = path.resolve(process.cwd(), 'src/lib/cron-auth.ts');

function requestWithBearer(token: string) {
  return new Request('http://localhost/api/ops/backend-dashboard', {
    headers: { authorization: `Bearer ${token}` },
  });
}

function requestWithAuthorization(authorization: string | null) {
  return new Request('http://localhost/api/ops/backend-dashboard', {
    headers: authorization ? { authorization } : undefined,
  });
}

type SecretEnvironmentKey =
  | 'CRON_SECRET'
  | 'CRON_SECRET_PREVIOUS'
  | 'OPS_READ_SECRET'
  | 'OPS_READ_SECRET_PREVIOUS';

function restoreEnvironment(key: SecretEnvironmentKey, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function clearSecretEnvironment() {
  delete process.env.CRON_SECRET;
  delete process.env.CRON_SECRET_PREVIOUS;
  delete process.env.OPS_READ_SECRET;
  delete process.env.OPS_READ_SECRET_PREVIOUS;
}

afterEach(() => {
  restoreEnvironment('CRON_SECRET', originalCronSecret);
  restoreEnvironment('CRON_SECRET_PREVIOUS', originalCronSecretPrevious);
  restoreEnvironment('OPS_READ_SECRET', originalOpsReadSecret);
  restoreEnvironment('OPS_READ_SECRET_PREVIOUS', originalOpsReadSecretPrevious);
});

describe('cron and ops authorization', () => {
  beforeEach(() => {
    clearSecretEnvironment();
  });

  it('requires an exact bearer token match for cron execution', () => {
    process.env.CRON_SECRET = 'cron-secret';
    process.env.OPS_READ_SECRET = 'ops-secret';

    expect(isAuthorizedCronRequest(requestWithAuthorization('Bearer cron-secret'))).toBe(true);
    expect(isAuthorizedCronRequest(requestWithAuthorization('Bearer wrong-secret'))).toBe(false);
    expect(isAuthorizedCronRequest(requestWithAuthorization('cron-secret'))).toBe(false);
    expect(isAuthorizedCronRequest(requestWithAuthorization(null))).toBe(false);
  });

  it('keeps cron execution restricted to the scheduler secret', () => {
    process.env.CRON_SECRET = 'cron-secret';
    process.env.OPS_READ_SECRET = 'ops-secret';

    expect(isAuthorizedCronRequest(requestWithBearer('cron-secret'))).toBe(true);
    expect(isAuthorizedCronRequest(requestWithBearer('ops-secret'))).toBe(false);
  });

  it('allows protected ops reads with the dedicated ops read secret', () => {
    process.env.CRON_SECRET = 'cron-secret';
    process.env.OPS_READ_SECRET = 'ops-secret';

    expect(isAuthorizedOpsRequest(requestWithBearer('ops-secret'))).toBe(true);
  });

  it('keeps cron secret compatibility for protected ops reads', () => {
    process.env.CRON_SECRET = 'cron-secret';
    process.env.OPS_READ_SECRET = 'ops-secret';

    expect(isAuthorizedOpsRequest(requestWithBearer('cron-secret'))).toBe(true);
  });

  it('fails closed when no matching protected ops secret is configured', () => {
    process.env.CRON_SECRET = '   ';
    process.env.OPS_READ_SECRET = '   ';

    expect(isAuthorizedOpsRequest(requestWithBearer('ops-secret'))).toBe(false);
  });

  it('accepts the current and previous cron secrets during rotation', () => {
    process.env.CRON_SECRET = 'cron-secret-new';
    process.env.CRON_SECRET_PREVIOUS = 'cron-secret-old';

    expect(isAuthorizedCronRequest(requestWithBearer('cron-secret-new'))).toBe(true);
    expect(isAuthorizedCronRequest(requestWithBearer('cron-secret-old'))).toBe(true);
    expect(isAuthorizedCronRequest(requestWithBearer('cron-secret-wrong'))).toBe(false);
  });

  it('accepts the current and previous ops read secrets during rotation', () => {
    process.env.OPS_READ_SECRET = 'ops-secret-new';
    process.env.OPS_READ_SECRET_PREVIOUS = 'ops-secret-old';

    expect(isAuthorizedOpsRequest(requestWithBearer('ops-secret-new'))).toBe(true);
    expect(isAuthorizedOpsRequest(requestWithBearer('ops-secret-old'))).toBe(true);
    expect(isAuthorizedOpsRequest(requestWithBearer('ops-secret-wrong'))).toBe(false);
  });

  it('keeps previous ops read secrets scoped away from cron execution', () => {
    process.env.CRON_SECRET = 'cron-secret';
    process.env.CRON_SECRET_PREVIOUS = 'cron-secret-old';
    process.env.OPS_READ_SECRET = 'ops-secret';
    process.env.OPS_READ_SECRET_PREVIOUS = 'ops-secret-old';

    expect(isAuthorizedCronRequest(requestWithBearer('ops-secret-old'))).toBe(false);
    expect(isAuthorizedOpsRequest(requestWithBearer('cron-secret-old'))).toBe(true);
  });

  it('behaves exactly as before when no previous secrets are configured', () => {
    process.env.CRON_SECRET = 'cron-secret';
    process.env.OPS_READ_SECRET = 'ops-secret';

    expect(isAuthorizedCronRequest(requestWithBearer('cron-secret'))).toBe(true);
    expect(isAuthorizedCronRequest(requestWithBearer('cron-secret-old'))).toBe(false);
    expect(isAuthorizedOpsRequest(requestWithBearer('ops-secret'))).toBe(true);
    expect(isAuthorizedOpsRequest(requestWithBearer('ops-secret-old'))).toBe(false);
  });

  it('ignores blank previous secrets and fails closed when nothing is configured', () => {
    process.env.CRON_SECRET = 'cron-secret';
    process.env.CRON_SECRET_PREVIOUS = '   ';

    expect(isAuthorizedCronRequest(requestWithBearer('cron-secret'))).toBe(true);
    expect(isAuthorizedCronRequest(requestWithBearer('   '))).toBe(false);

    clearSecretEnvironment();

    expect(isAuthorizedCronRequest(requestWithBearer('cron-secret'))).toBe(false);
    expect(isAuthorizedOpsRequest(requestWithBearer('ops-secret'))).toBe(false);
    expect(isAuthorizedCronRequest(requestWithAuthorization(null))).toBe(false);
  });

  it('uses a timing-safe comparison for protected bearer secrets', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('timingSafeEqual');
    expect(source).not.toContain("request.headers.get('authorization') ===");
  });
});
