import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const scriptPath = path.join(process.cwd(), 'scripts', 'ops', 'apple-web-client-secret.mjs');

// The web's Continue with Apple fails once the client secret this mints ends, so its
// claims and its 180-day lifetime (Apple's ceiling is six months) are held here.
describe('Apple web client secret helper', () => {
  it('self-tests the claims, the header and the lifetime of the secret it signs', () => {
    const output = execFileSync(process.execPath, [scriptPath, '--self-test'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(output).toContain('apple-web-client-secret self-test passed');
  });

  it('names a missing argument and mints nothing', () => {
    let message = '';
    try {
      execFileSync(process.execPath, [scriptPath, '--p8', 'AuthKey.p8', '--key-id', 'K', '--team-id', 'T'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      message = String((error as { stderr?: string }).stderr ?? '');
    }

    expect(message).toContain('Missing --client-id');
  });
});
