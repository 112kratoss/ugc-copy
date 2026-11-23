// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const PRELOAD = path.join(repoRoot, 'tests/e2e/support/dev-server.cjs');

// A server as `next dev` makes one, a plain `http.createServer(listener)`, with its idle limit scaled
// down: 2 s and Node's buffer of 1 s, where next dev's 5 s makes 6 s (a limit under 1 s is announced as
// `Keep-Alive: timeout=0`, and Node's agent then does not pool the socket at all). A request for /compile
// holds the event loop inside its callback for 4 s, as a dev compile does.
const SERVER = `
const http = require('node:http');
const server = http.createServer({ keepAliveTimeout: 2000 }, (req, res) => {
  if (req.url === '/compile') {
    const end = Date.now() + 4000;
    while (Date.now() < end);
  }
  res.end('ok');
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`;

// Playwright's request client: an agent that keeps sockets alive and has no timeout of its own, so a socket
// stays in its pool until the server closes it. One read leaves a socket in the pool. 300 ms later another
// request, on a socket of its own, holds the server's loop for 4 s; 300 ms after that the pooled socket is
// written to, 600 ms into an idle limit of 3 s that falls inside the hold. Prints how that read ended.
const CLIENT = `
const http = require('node:http');
const port = Number(process.argv[1]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pool = new http.Agent({ keepAlive: true });
const get = (agent, path) => new Promise((resolve) => {
  const request = http.get({ host: '127.0.0.1', port, path, agent }, (response) => {
    response.resume();
    response.on('end', () => resolve({ ok: true, status: response.statusCode }));
  });
  request.on('error', (error) => resolve({ ok: false, code: error.code, message: error.message }));
});
(async () => {
  await get(pool, '/');
  await sleep(300);
  const compile = get(new http.Agent(), '/compile');
  await sleep(300);
  const reused = await get(pool, '/');
  await compile;
  console.log(JSON.stringify(reused));
  pool.destroy();
})();
`;

const started: ChildProcess[] = [];

afterAll(() => {
  for (const child of started) if (child.exitCode === null) child.kill();
});

function node(args: string[]) {
  const child = spawn(process.execPath, args, {
    env: { PATH: process.env.PATH, NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  started.push(child);
  return child;
}

/** Everything the child prints, once it has exited cleanly. */
function printedBy(child: ChildProcess) {
  return new Promise<string>((resolve, reject) => {
    let out = '';
    let err = '';
    child.stdout!.on('data', (chunk) => { out += chunk; });
    child.stderr!.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err}`))));
  });
}

/** The first line the child prints. */
function firstLinePrintedBy(child: ChildProcess) {
  return new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (chunk) => {
      out += chunk;
      if (out.includes('\n')) resolve(out.split('\n')[0]);
    });
    child.on('error', reject);
    child.on('close', (code) => reject(new Error(`the server exited with ${code} before it listened`)));
  });
}

/** One server, with `preload` as `--require` arguments as next dev's gets its preload, and a client; how the client's second read ended. */
async function secondRead(preload: string[]) {
  const server = node([...preload, '-e', SERVER]);
  const port = await firstLinePrintedBy(server);
  return JSON.parse(await printedBy(node(['-e', CLIENT, port]))) as {
    ok: boolean;
    status?: number;
    code?: string;
    message?: string;
  };
}

// The failure of Quality run 44687738266 and seven more (model-catalog-transport.spec.ts:173,
// creator-canvas.spec.ts:263): `apiRequestContext.get: read ECONNRESET` with nothing in the dev server's
// log; tests/e2e/support/keep-alive-sockets.cjs has the chain. Both servers run the same sequence. The one
// without the preload is the control: a green run of the other proves nothing unless the sequence is one
// that can fail, so the control has to see the reset first.
describe('the E2E dev server and Playwright\'s pooled sockets', () => {
  it('answers a pooled socket that is written to while its loop is busy past the idle limit, where a plain server resets it', async () => {
    const [plain, preloaded] = await Promise.all([secondRead([]), secondRead(['--require', PRELOAD])]);

    expect(plain, 'the control: a server without the preload').toMatchObject({
      ok: false,
      code: 'ECONNRESET',
      message: 'read ECONNRESET',
    });
    expect(preloaded).toEqual({ ok: true, status: 200 });
  }, 30_000);

  it('leaves every server the preloaded process makes without an idle timeout', async () => {
    const child = node([
      '--require',
      PRELOAD,
      '-e',
      'console.log(JSON.stringify([globalThis.__e2eKeepAliveSockets, require("node:http").createServer().keepAliveTimeout, require("node:http").createServer({ keepAliveTimeout: 9000 }).keepAliveTimeout]))',
    ]);

    expect(JSON.parse(await printedBy(child))).toEqual([true, 0, 0]);
  });
});
