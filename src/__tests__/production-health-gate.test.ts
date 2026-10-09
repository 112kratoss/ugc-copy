// @vitest-environment node
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { verifyProductionHealth } from '../../.github/scripts/verify-production-health.mjs';

const sha = 'a'.repeat(40);
const workflow = readFileSync('.github/workflows/production-release.yml', 'utf8');
const step = workflow.split('      - name: Require protected production health after promotion\n')[1];
const commands = step.split('        run: |\n')[1].split('\n      - name:')[0]
  .split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');

it.each(['missing-id', 'empty-id', 'array-id', 'stale-then-current', 'degraded', 'unauthorized', 'malformed', 'matching', 'redirect'] as const)('runs the actual protected-health shell gate: %s', async (mode) => {
  let calls = 0;
  const authorizations: Array<string | undefined> = [];
  const server = createServer((req, res) => {
    calls++; authorizations.push(req.headers.authorization);
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'unauthorized') res.statusCode = 401;
    if (mode === 'redirect') { res.writeHead(302, { Location: '/redirected' }); res.end(); return; }
    if (mode === 'malformed') { res.end('{'); return; }
    res.end(JSON.stringify({
      ...(mode === 'missing-id' ? {} : { buildId: mode === 'empty-id' ? '' : mode === 'array-id' ? [sha] : mode === 'stale-then-current' && calls === 1 ? 'b'.repeat(40) : sha }),
      status: mode === 'degraded' ? 'degraded' : 'ok',
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture port');
  const directory = mkdtempSync(path.join(tmpdir(), 'profile-audit-health-'));
  try {
    const child = spawn('bash', ['-c', commands], {
      env: { ...process.env, PRODUCTION_BASE_URL: `http://127.0.0.1:${address.port}`, OPS_READ_SECRET: 'local-disposable-fixture', RELEASE_SHA: sha, RUNNER_TEMP: directory },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { output += String(chunk); });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Health gate timeout')); }, 18000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve(code); });
    });
    expect(output).not.toContain('local-disposable-fixture');
    expect(authorizations.every(value => value === 'Bearer local-disposable-fixture')).toBe(true);
    if (mode === 'matching' || mode === 'stale-then-current') {
      expect(code).toBe(0);
      expect(calls).toBe(mode === 'matching' ? 1 : 2);
    } else {
      expect(code).not.toBe(0);
      expect(calls).toBe(1);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);

it('fails closed after twelve actual stale HTTP responses without retrying indefinitely', async () => {
  let calls = 0;
  const server = createServer((_req, res) => { calls++; res.end(JSON.stringify({ buildId: 'b'.repeat(40), status: 'ok' })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture port');
  try {
    await expect(verifyProductionHealth({ origin: `http://127.0.0.1:${address.port}`, releaseSha: sha, secret: 'local-only', intervalMs: 1, timeoutMs: 5000, log: () => {} }))
      .rejects.toThrow('within its verification window');
    expect(calls).toBe(12);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it('enforces a total deadline as well as an attempt limit', async () => {
  let time = 0, calls = 0;
  await expect(verifyProductionHealth({
    origin: 'https://unused.invalid', releaseSha: sha, secret: 'local-only', timeoutMs: 10, intervalMs: 10,
    now: () => time, sleep: async (ms: number) => { time += ms; }, log: () => {},
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({ buildId: 'b'.repeat(40), status: 'ok' })); },
  })).rejects.toThrow('within its verification window');
  expect(calls).toBe(1);
});

it('aborts an actual nonresponding endpoint within its total deadline', async () => {
  const server = createServer(() => {});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture port');
  try {
    await expect(verifyProductionHealth({ origin: `http://127.0.0.1:${address.port}`, releaseSha: sha, secret: 'local-only', timeoutMs: 50, log: () => {} }))
      .rejects.toThrow('request failed');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it.each(['matching', 'missing', 'stale', 'degraded'] as const)('runs the actual staged health verifier: %s', async mode => {
  const verifier = workflow.match(/node -e "\n(\s+const fs = require\('node:fs'\);\n\s+const body = JSON.parse\(fs.readFileSync\(process.env.RUNNER_TEMP \+ '\/backend-health.json'[\s\S]*?)\n          "/)?.[1];
  expect(verifier).toBeDefined();
  const directory = mkdtempSync(path.join(tmpdir(), 'staged-audit-health-'));
  try {
    writeFileSync(path.join(directory, 'backend-health.json'), JSON.stringify({
      ...(mode === 'missing' ? {} : { buildId: mode === 'stale' ? 'b'.repeat(40) : sha }),
      status: mode === 'degraded' ? 'degraded' : 'ok',
    }));
    const child = spawn(process.execPath, ['-e', verifier!], {
      env: { ...process.env, RUNNER_TEMP: directory, RELEASE_SHA: sha, EXPECTED_ABANDONED_RECLAIM_EFFECTIVE: '' }, stdio: 'ignore',
    });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    expect(code === 0).toBe(mode === 'matching');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
