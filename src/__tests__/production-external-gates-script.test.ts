import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildAppleWebAuthorizationUrl, getAppleWebReturnUrl } from '@/lib/apple-web-reauthentication';

import {
  buildAppleDeletionAuthorizeUrl,
  SITE_APPLE_DELETION_RETURN_URL,
} from '../../scripts/ops/production-external-gates.mjs';

const scriptPath = path.join(process.cwd(), 'scripts', 'ops', 'production-external-gates.mjs');

describe('production external gates helper', () => {
  it('self-tests advisor parsing and the narrow Supabase Auth patch payload', () => {
    const output = execFileSync(process.execPath, [scriptPath, '--self-test'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(output).toContain('production-external-gates self-test passed');
  });

  // The deletion probe asks Apple about the request the deletion page sends, on production's site.
  it("probes Apple with the deletion page's own request", () => {
    expect(SITE_APPLE_DELETION_RETURN_URL).toBe(getAppleWebReturnUrl('https://magicbooklet.com'));
    expect(buildAppleDeletionAuthorizeUrl('com.example.app.web')).toBe(buildAppleWebAuthorizationUrl({
      clientId: 'com.example.app.web',
      returnUrl: SITE_APPLE_DELETION_RETURN_URL,
      state: 'external-gates-probe',
    }));
  });
});
