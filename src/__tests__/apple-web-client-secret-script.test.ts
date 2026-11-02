// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { importSPKI, jwtVerify } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = path.join(process.cwd(), 'scripts', 'ops', 'apple-web-client-secret.mjs');
const made: string[] = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-secret-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A throwaway P-256 key in a .p8 file, with its public half's SHA-256, the pin the workflow uses. */
function throwawayKey(dir: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const p8 = path.join(dir, 'AuthKey_TEST.p8');
  fs.writeFileSync(p8, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return { p8, publicKey, fingerprint: createHash('sha256').update(spki).digest('hex') };
}

function mint(args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });
}

// The website's Continue with Apple fails once the client secret this mints ends, and a
// monthly workflow applies it unattended (the runbook's "Sign in with Apple on the web").
describe('Apple web client secret helper', () => {
  it('self-tests from a folder without node_modules: Node built-ins only', () => {
    const copy = path.join(tempDir(), 'apple-web-client-secret.mjs');
    fs.copyFileSync(scriptPath, copy);

    const output = execFileSync(process.execPath, [copy, '--self-test'], { encoding: 'utf8', cwd: path.dirname(copy) });

    expect(output).toContain('apple-web-client-secret self-test passed');
  });

  // Its own self-test signs and verifies with the same crypto; jose is a second implementation.
  it('mints a JWT that jose verifies, for the Services ID, for 180 days, into a file only its owner reads', async () => {
    const dir = tempDir();
    const key = throwawayKey(dir);
    const out = path.join(dir, 'secret.jwt');

    const result = mint(['--p8', key.p8, '--key-id', 'KEY1234567', '--key-sha256', key.fingerprint,
      '--team-id', 'TEAM123456', '--client-id', 'com.example.app.web', '--out', out]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`Key SHA-256 ${key.fingerprint}`);
    const secret = fs.readFileSync(out, 'utf8');
    expect(result.stderr).not.toContain(secret);
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
    const publicPem = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const { payload, protectedHeader } = await jwtVerify(secret, await importSPKI(publicPem, 'ES256'), {
      issuer: 'TEAM123456',
      audience: 'https://appleid.apple.com',
      subject: 'com.example.app.web',
    });
    expect(protectedHeader).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    expect(payload.exp! - payload.iat!).toBe(180 * 24 * 60 * 60);
  });

  it('refuses a key whose public half is not the pinned one, and mints nothing', () => {
    const dir = tempDir();
    const key = throwawayKey(dir);
    const out = path.join(dir, 'secret.jwt');

    const result = mint(['--p8', key.p8, '--key-id', 'KEY1234567', '--key-sha256', 'a'.repeat(64),
      '--team-id', 'TEAM123456', '--client-id', 'com.example.app.web', '--out', out]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`The key's public SHA-256 is ${key.fingerprint}, not the pinned ${'a'.repeat(64)}`);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('names a missing argument and mints nothing', () => {
    const result = mint(['--p8', 'AuthKey.p8', '--key-id', 'K', '--team-id', 'T']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing --client-id');
  });
});
