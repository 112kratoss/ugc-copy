import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

function read(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// Apple refuses a client secret that lives longer than six months, and the website's Continue
// with Apple fails the day the one in Supabase ends, so a monthly workflow renews it (the
// runbook's "Sign in with Apple on the web").
describe('the Apple web client secret renewal', () => {
  const workflow = read('.github/workflows/apple-web-client-secret.yml');
  const script = read('scripts/ops/apple-web-client-secret.mjs');
  /** The workflow without its comment lines: what runs. */
  const steps = workflow.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');

  it('runs monthly, and on demand, in the production environment', () => {
    expect(workflow).toContain("- cron: '17 3 1 * *'");
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('environment: production');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toMatch(/permissions:\n {2}contents: read\n {2}issues: write\n/);
  });

  it('mints and installs for the configured Services ID, then checks where Supabase sends a press', () => {
    expect(workflow).toContain('APPLE_SIGN_IN_KEY_ID: 6924Q753C6');
    expect(workflow).toContain('APPLE_TEAM_ID: 5HNNML93ST');
    expect(workflow).toContain('APPLE_WEB_SERVICES_ID: com.magicbooklet.mobile.web');
    expect(workflow).toContain('APPLE_SIGN_IN_PRIVATE_KEY: ${{ secrets.APPLE_SIGN_IN_PRIVATE_KEY }}');
    expect(workflow).toContain('SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}');
    expect(workflow).toContain('node scripts/ops/apple-web-client-secret.mjs --install-supabase');
    expect(workflow).toContain('SUPABASE_MANAGEMENT_API_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}');
    expect(workflow).toContain('node scripts/ops/production-external-gates.mjs --probe-apple-web-sign-in');
    expect(workflow.indexOf('--install-supabase')).toBeLessThan(workflow.indexOf('--probe-apple-web-sign-in'));
  });

  it('says so in an incident issue when it fails, and closes it on recovery', () => {
    expect(workflow.match(/INCIDENT_TITLE: Apple web client secret renewal is failing/g)).toHaveLength(2);
    expect(workflow).toContain('if: failure()');
    expect(workflow).toContain('if: success()');
  });

  // Each run bills Actions minutes once the repository is private, so it installs nothing.
  it('needs no package install: the script imports only Node built-ins', () => {
    expect(steps).not.toMatch(/npm (ci|install)/);
    const imports = [...script.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((source) => source.startsWith('node:'))).toBe(true);
  });

  it('never puts the key or the minted secret in the run log', () => {
    expect(steps).not.toMatch(/(echo|printf|cat)[^\n]*\$\{?APPLE_SIGN_IN_PRIVATE_KEY/);
    expect(steps).not.toMatch(/set -[a-z]*x/);
    // No console call is handed the secret, bare or inside a template.
    const consoleCalls = [...script.matchAll(/console\.(?:log|error)\(([^;]*)\);/g)].map((match) => match[1]);
    expect(consoleCalls.length).toBeGreaterThan(0);
    expect(consoleCalls.filter((call) => /\$\{secret\}|^\s*secret\s*(,|$)/.test(call))).toEqual([]);
    expect(script).not.toContain('process.stdout.write(secret');
  });
});
