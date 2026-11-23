// Keeps the E2E dev server from closing an idle keep-alive socket, so that a socket Playwright's request
// client has pooled cannot be reset under it.
//
// The `request` fixture and `page.request` share one keep-alive pool for the whole worker
// (`httpHappyEyeballsAgent` in playwright-core/lib/server/utils/happyEyeballs.js), so the socket one
// test's API read used is the next test's first. Node's client agent honours a server's `Keep-Alive:
// timeout=5` only on an agent that has a timeout of its own (`keepSocketAlive` in `_http_agent.js`, the
// same in Node 22 and 24), and this one has none: a pooled socket stays until the server closes it.
// `next dev` is a plain `http.createServer(listener)` (next/dist/server/lib/start-server.js) with Node's
// keepAliveTimeout of 5 s, which closes a socket 6 s after its last response (5 s and a buffer of 1 s).
// A dev compile holds the server's event loop inside an I/O callback for seconds. When the 6 s mark falls
// in one, the idle timer runs first on the loop's next turn and destroys the socket before the server has
// read the request the client wrote to it meanwhile, and the kernel answers the client with a reset:
// `apiRequestContext.get: read ECONNRESET`, with nothing in the server's log. That is how
// model-catalog-transport.spec.ts:173 and creator-canvas.spec.ts:263 failed in eight Quality runs from
// 2026-11-17 to 2026-11-23: the first API read of the test, on the socket the test before it left pooled.
//
// A keepAliveTimeout of 0 leaves the idle timer off: the server never closes a socket first, so a pooled
// socket stays good until the server process ends (a memory-threshold restart ends every socket, as
// before). `next start` takes `--keepAliveTimeout`, `next dev` takes no such option, so the server it
// makes is changed here, the way the .env guard and the Supabase stub change what it reads.
// Only `http.createServer` is wrapped, which is how `next dev` makes its server (start-server.js). A server
// made with `new http.Server()` or with `https.createServer` (`next dev --experimental-https`, which this
// suite does not use) keeps Node's default.
// e2e-dev-server-keep-alive.test.ts runs the sequence with and without this file.
'use strict';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require('node:http');

if (!globalThis.__e2eKeepAliveSockets) {
  globalThis.__e2eKeepAliveSockets = true;
  const createServer = http.createServer;

  http.createServer = function createServerWithoutIdleTimeout() {
    const server = createServer.apply(this, arguments);
    server.keepAliveTimeout = 0;
    return server;
  };
}
