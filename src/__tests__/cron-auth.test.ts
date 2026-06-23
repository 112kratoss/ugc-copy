import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  isAuthorizedCronRequest,
  isAuthorizedOpsRequest,
} from '@/lib/cron-auth';

const originalCronSecret = process.env.CRON_SECRET;
const originalOpsReadSecret = process.env.OPS_READ_SECRET;
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

function restoreEnvironment(key: 'CRON_SECRET' | 'OPS_READ_SECRET', value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnvironment('CRON_SECRET', originalCronSecret);
  restoreEnvironment('OPS_READ_SECRET', originalOpsReadSecret);
});

describe('cron and ops authorization', () => {
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

  it('uses a timing-safe comparison for protected bearer secrets', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('timingSafeEqual');
    expect(source).not.toContain("request.headers.get('authorization') ===");
  });
});
