import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isAuthorizedCronRequest } from '@/lib/cron-auth';

const originalCronSecret = process.env.CRON_SECRET;
const sourcePath = path.resolve(process.cwd(), 'src/lib/cron-auth.ts');

function cronRequest(authorization: string | null) {
  return new Request('https://magicbooklet.com/api/cron/example', {
    headers: authorization ? { authorization } : undefined,
  });
}

afterEach(() => {
  if (originalCronSecret === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = originalCronSecret;
  }
});

describe('cron auth', () => {
  it('requires an exact bearer token match', () => {
    process.env.CRON_SECRET = 'cron-secret';

    expect(isAuthorizedCronRequest(cronRequest('Bearer cron-secret'))).toBe(true);
    expect(isAuthorizedCronRequest(cronRequest('Bearer wrong-secret'))).toBe(false);
    expect(isAuthorizedCronRequest(cronRequest('cron-secret'))).toBe(false);
    expect(isAuthorizedCronRequest(cronRequest(null))).toBe(false);
  });

  it('fails closed when the cron secret is missing', () => {
    delete process.env.CRON_SECRET;

    expect(isAuthorizedCronRequest(cronRequest('Bearer cron-secret'))).toBe(false);
  });

  it('uses a timing-safe comparison for cron bearer secrets', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('timingSafeEqual');
    expect(source).not.toContain("request.headers.get('authorization') ===");
  });
});
