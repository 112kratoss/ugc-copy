// @vitest-environment node
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

  it('runs monthly, and on demand with a rotate switch, one run at a time, from main only', () => {
    expect(workflow).toContain("- cron: '17 3 1 * *'");
    expect(workflow).toMatch(/workflow_dispatch:\n {4}inputs:\n {6}rotate:\n/);
    expect(workflow).toContain("ROTATE_FLAG: ${{ inputs.rotate && '--rotate' || '' }}");
    expect(workflow).toMatch(/permissions:\n {2}contents: read\n {2}issues: write\n/);
    expect(workflow).toMatch(/concurrency:\n {2}group: apple-web-client-secret\n {2}cancel-in-progress: false\n/);
    // A dispatch from another branch would run that branch's script with the production key.
    expect(workflow).toMatch(/ {2}renew:\n(?: {4}.*\n)*? {4}if: github\.ref == 'refs\/heads\/main'\n/);
  });

  // On GitHub Free a private repository cannot read environment secrets, and the owner will
  // make this one private after launch.
  it('reads repository secrets, never an environment', () => {
    expect(steps).not.toMatch(/^\s+environment:/m);
    expect(workflow).toContain('APPLE_SIGN_IN_PRIVATE_KEY: ${{ secrets.APPLE_SIGN_IN_PRIVATE_KEY }}');
    expect(workflow.match(/SUPABASE_MANAGEMENT_API_TOKEN: \$\{\{ secrets\.SUPABASE_AUTH_CONFIG_TOKEN \}\}/g)).toHaveLength(2);
  });

  it('holds the key to its public SHA-256, self-tests, applies, then checks where Supabase sends a press', () => {
    expect(workflow).toMatch(/APPLE_SIGN_IN_KEY_SHA256: [0-9a-f]{64}\n/);
    expect(workflow).toContain('--key-sha256 "${APPLE_SIGN_IN_KEY_SHA256}"');
    expect(workflow).toContain('SUPABASE_AUTH_CALLBACK_URL: ${{ vars.SUPABASE_AUTH_CALLBACK_URL }}');
    const order = ['--self-test', '--apply-supabase', '--probe-apple-web-sign-in'].map((command) => steps.indexOf(command));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  // A job that runs out of time is cancelled, not failed. A run that failed at its checkout has
  // no git remote, so `gh` takes the repository from GH_REPO.
  it('says so in an incident issue when it fails or times out, and closes it on recovery', () => {
    expect(workflow).toContain('if: failure() || cancelled()');
    expect(workflow).toContain('if: success()');
    expect(workflow).toContain('INCIDENT_TITLE: Apple web client secret renewal is failing');
    expect(workflow.match(/GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}\n(?: {10}#.*\n)* {10}GH_REPO: \$\{\{ github\.repository \}\}\n/g)).toHaveLength(2);
  });

  it('never puts the key or the minted secret in the run log', () => {
    expect(steps).not.toMatch(/(echo|printf|cat)[^\n]*\$\{?APPLE_SIGN_IN_PRIVATE_KEY/);
    expect(steps).not.toMatch(/set -[a-z]*x/);
    const consoleLines = script.split('\n').filter((line) => /console\.(log|error)\(/.test(line));
    expect(consoleLines.length).toBeGreaterThan(2);
    expect(consoleLines.filter((line) => /\$\{secret\}|console\.(log|error)\(\s*secret\b/.test(line))).toEqual([]);
    expect(script).not.toContain('process.stdout.write');
  });
});
