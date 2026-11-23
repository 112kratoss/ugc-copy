// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const PRELOAD = path.join(repoRoot, 'tests/e2e/support/dev-server.cjs');

// A server as `next dev` makes one, a plain `http.createServer(listener)`, with its idle limit scaled
// down: 3 s and Node's buffer of 1 s, where next dev's 5 s makes 6 s (a limit under 1 s is announced as
// `Keep-Alive: timeout=0`, and Node's agent then does not pool the socket at all). A request for /compile
// holds the event loop inside its callback for 6 s, as a dev compile does, after saying so on stdout
// (written synchronously, so the line is out before the loop is held). It prints its port when it listens.
const SERVER = `
const fs = require('node:fs');
const http = require('node:http');
const server = http.createServer({ keepAliveTimeout: 3000 }, (req, res) => {
  if (req.url === '/compile') {
    fs.writeSync(1, 'compiling\\n');
    const end = Date.now() + 6000;
    while (Date.now() < end);
  }
  res.end('ok');
});
server.listen(0, '127.0.0.1', () => fs.writeSync(1, server.address().port + '\\n'));
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

/** The lines a child prints, one `next()` at a time, as they arrive; `next()` fails if the child exits first. */
function linesOf(child: ChildProcess) {
  const waiting: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  const arrived: string[] = [];
  let partial = '';
  let err = '';
  let ended: Error | undefined;
  child.stdout!.on('data', (chunk) => {
    partial += chunk;
    for (let at = partial.indexOf('\n'); at >= 0; at = partial.indexOf('\n')) {
      const line = partial.slice(0, at);
      partial = partial.slice(at + 1);
      const next = waiting.shift();
      if (next) next.resolve(line);
      else arrived.push(line);
    }
  });
  child.stderr!.on('data', (chunk) => { err += chunk; });
  child.on('close', (code) => {
    ended = new Error(`the server exited with ${code}: ${err}`);
    for (const next of waiting.splice(0)) next.reject(ended);
  });
  return {
    next: () => new Promise<string>((resolve, reject) => {
      const line = arrived.shift();
      if (line !== undefined) resolve(line);
      else if (ended) reject(ended);
      else waiting.push({ resolve, reject });
    }),
  };
}

type Read = { ok: true; status?: number } | { ok: false; code?: string; message: string };

function get(agent: http.Agent, port: number, urlPath: string) {
  return new Promise<Read>((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: urlPath, agent }, (response) => {
      response.resume();
      response.on('end', () => resolve({ ok: true, status: response.statusCode }));
    });
    request.on('error', (error: NodeJS.ErrnoException) => resolve({ ok: false, code: error.code, message: error.message }));
  });
}

/**
 * One server, with `preload` as `--require` arguments as next dev's gets its preload, and Playwright's request
 * client (an agent that keeps sockets alive and has no timeout of its own, so a socket stays in its pool until
 * the server closes it). One read leaves a socket in the pool, its idle time running. A request on a socket of its
 * own holds the server's loop; the pooled socket is written to only once the server has said it is held, so the
 * write is in the server's buffer unread, whatever the machine's load, and the idle limit (4 s) falls inside the
 * 6 s hold. The loop is the server's own process: the client here is never held. Returns how that read ended.
 */
async function pooledRead(preload: string[]) {
  const server = node([...preload, '-e', SERVER]);
  const lines = linesOf(server);
  const port = Number(await lines.next());
  const pool = new http.Agent({ keepAlive: true });
  const other = new http.Agent();
  try {
    await get(pool, port, '/');
    const compile = get(other, port, '/compile');
    await lines.next();
    const read = await get(pool, port, '/');
    await compile;
    return read;
  } finally {
    pool.destroy();
    other.destroy();
    server.kill();
  }
}

// The failure of Quality run 44687738266 and seven more (model-catalog-transport.spec.ts:173,
// creator-canvas.spec.ts:263): `apiRequestContext.get: read ECONNRESET` with nothing in the dev server's
// log; tests/e2e/support/keep-alive-sockets.cjs has the chain. Both servers run the same sequence. The one
// without the preload is the control: a green run of the other proves nothing unless the sequence is one
// that can fail, so the control has to see the reset first.
describe('the E2E dev server and Playwright\'s pooled sockets', () => {
  it('answers a pooled socket that is written to while its loop is busy past the idle limit, where a plain server resets it', async () => {
    const [plain, preloaded] = await Promise.all([pooledRead([]), pooledRead(['--require', PRELOAD])]);

    expect(plain, 'the control: a server without the preload').toMatchObject({
      ok: false,
      code: 'ECONNRESET',
      message: 'read ECONNRESET',
    });
    expect(preloaded).toEqual({ ok: true, status: 200 });
  }, 30_000);

  it('leaves every server http.createServer makes in the preloaded process without an idle timeout', async () => {
    const child = node([
      '--require',
      PRELOAD,
      '-e',
      'console.log(JSON.stringify([globalThis.__e2eKeepAliveSockets, require("node:http").createServer().keepAliveTimeout, require("node:http").createServer({ keepAliveTimeout: 9000 }).keepAliveTimeout]))',
    ]);

    expect(JSON.parse(await printedBy(child))).toEqual([true, 0, 0]);
  });
});
