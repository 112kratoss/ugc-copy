---
paths:
  - "**/tests/e2e/**"
  - "**/playwright.config.ts"
  - "**/src/lib/e2e-auth.ts"
---

# E2E (Playwright) gotchas

Moved unchanged from `AGENTS.md` on 2026-10-18 so it loads only where it applies; the core file keeps a summary and points here.

Three E2E gotchas worth knowing before you debug one:

- **Playwright's own dev server refuses to start if another `next dev` is already running**, even on a different port, and the failure reads as a config error. Stop any preview/dev server (including one started via `preview_start`) before `npm run test:e2e`.
- **The auth bypass needs its cookie, not just the env vars.** A spec that only visits an authenticated route lands on `/login`; add `{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }` via `context.addCookies` first (see the existing specs).
- **The dev server reloads an open page when another page connects after a compile.** `next dev --webpack` compiles a route the first time it is requested, and each compile gives the client build a new hash. Whenever any page opens its dev socket the server sends `sync`, with the current hash, to every open page, and a page that reads a hash other than the one it loaded with reloads itself — Next takes the change for a server restart (`next/dist/client/dev/hot-reloader/app/web-socket.js`; the hot update itself applies fine). Two pages and one first request are enough: one Playwright worker's test compiles a route, the next page to load reloads the page under the other worker's test, and whatever that test had typed or attached in memory is gone. CI therefore runs the suite on one worker (`playwright.config.ts`), which never has two pages open; a local run with several workers still meets it (`--workers=1` avoids it), and so would a spec that opens two pages. A self-reload landing in the same tick as a spec's own navigation cancels it, surfacing as `net::ERR_ABORTED; maybe frame was detached?`. `tests/e2e/kling-o3-named-subjects.spec.ts` carries the retry helper for it.
