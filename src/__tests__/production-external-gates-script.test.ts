import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildAppleDeletionAuthorizeUrl,
  siteAppleDeletionReturnUrl,
} from '../../scripts/ops/production-external-gates.mjs';

const scriptPath = path.join(process.cwd(), 'scripts', 'ops', 'production-external-gates.mjs');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('production external gates helper', () => {
  it('self-tests advisor parsing and the narrow Supabase Auth patch payload', () => {
    const output = execFileSync(process.execPath, [scriptPath, '--self-test'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(output).toContain('production-external-gates self-test passed');
  });

  // Node runs a script by its real path; a path through a symlink once skipped
  // every check and exited 0 without a word.
  it('runs as a command through a symlinked path', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'external-gates-'));
    try {
      const linkedPath = path.join(directory, 'production-external-gates.mjs');
      symlinkSync(scriptPath, linkedPath);
      const output = execFileSync(process.execPath, [linkedPath, '--self-test'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });

      expect(output).toContain('production-external-gates self-test passed');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // The deletion probe asks Apple about the request the deletion page sends,
  // for the site address Vercel gives both.
  it.each([
    ['unset', undefined],
    ['the apex with a trailing slash', 'https://magicbooklet.com/'],
    ['the www host', 'https://www.magicbooklet.com'],
  ])("probes Apple with the deletion page's own request when NEXT_PUBLIC_SITE_URL is %s", async (_label, siteUrl) => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', siteUrl);
    // The site reads its address as its modules load.
    vi.resetModules();
    const { buildAppleWebAuthorizationUrl, getAppleWebReturnUrl } = await import('@/lib/apple-web-reauthentication');
    const returnUrl = getAppleWebReturnUrl();

    expect(siteAppleDeletionReturnUrl()).toBe(returnUrl);
    expect(buildAppleDeletionAuthorizeUrl('com.example.app.web')).toBe(buildAppleWebAuthorizationUrl({
      clientId: 'com.example.app.web',
      returnUrl,
      state: 'external-gates-probe',
    }));
  });
});
