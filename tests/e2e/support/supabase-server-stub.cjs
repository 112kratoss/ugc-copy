// The Supabase reads the E2E dev server answers itself, so that a spec can draw a page whose
// server render reads its data.
//
// CI's E2E job points the app at a placeholder project, https://example.supabase.co
// (.github/workflows/quality.yml), a host with no DNS record: every read the server makes fails,
// and a page that reads its data on the server draws its error state. The creator page,
// /creators/<name>, reads its creator in getCreatorProfileSummary (src/lib/creator-profile.ts).
// Playwright's page.route answers only the browser's requests. So playwright.config.ts loads this
// file into the dev server (NODE_OPTIONS --require), where it wraps fetch: a request that matches
// one of READS below is answered here, before anything leaves the process, and every other
// request goes on as before. A page no spec draws through this file fails offline as it did.
//
// The data is one creator, owned by the E2E user (`workflow-user`, src/lib/e2e-auth.ts), who has
// published nothing: the profiles row in fixtures/creator-profile.json, which the specs read too.
// A page added here brings each of its reads, matched by method, path and the filters that name
// its own rows: a whole table answered with no rows would change what every other page draws.
//
//   E2E_SUPABASE_STUB_LOG=<file>  appends one line per request to the host, answered or passed on.
'use strict';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { appendFileSync } = require('node:fs');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const creator = require('../fixtures/creator-profile.json');

const HOST = 'example.supabase.co';

function json(body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

const READS = [
  {
    // loadCreatorProfileRow: the creator by handle. maybeSingle() asks for a list.
    methods: ['GET'],
    path: '/rest/v1/profiles',
    filters: { username: `eq.${creator.username}` },
    answer: ({ wantsObject }) => json(wantsObject ? creator : [creator], { 'content-range': '0-0/1' }),
  },
  {
    // fetchCreatorPostRows, and getCreatorPublicPostCount's head count: none published.
    methods: ['GET', 'HEAD'],
    path: '/rest/v1/posts',
    filters: { user_id: `eq.${creator.id}`, visibility: 'eq.public' },
    answer: ({ method }) => (method === 'HEAD'
      ? new Response(null, { status: 200, headers: { 'content-range': '*/0' } })
      : json([], { 'content-range': '*/0' })),
  },
  {
    // loadCreatorStats: the page's totals.
    methods: ['POST'],
    path: '/rest/v1/rpc/get_creator_profile_stats',
    body: { p_creator_id: creator.id },
    answer: () => json({ publicCreations: 0, totalSaves: 0, totalRemixes: 0, unlocks: 0, totalUnlockSales: 0, toolsUsed: [] }),
  },
];

// A JSON body as supabase-js sends it (a string in init), or null for one this cannot read
// without using it up.
async function readJsonBody(input, init) {
  try {
    if (typeof init?.body === 'string') return JSON.parse(init.body);
    if (init?.body == null && input instanceof Request) return JSON.parse(await input.clone().text());
  } catch {
    // Not JSON: no read here matches it.
  }
  return null;
}

async function answer(method, url, input, init) {
  for (const read of READS) {
    if (!read.methods.includes(method) || url.pathname !== read.path) continue;
    if (!Object.entries(read.filters ?? {}).every(([key, value]) => url.searchParams.get(key) === value)) continue;
    if (read.body) {
      const body = await readJsonBody(input, init);
      if (!body || !Object.entries(read.body).every(([key, value]) => body[key] === value)) continue;
    }
    const accept = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('accept') ?? '';
    return read.answer({ method, wantsObject: accept.includes('application/vnd.pgrst.object+json') });
  }
  return null;
}

if (typeof globalThis.fetch === 'function' && !globalThis.__e2eSupabaseServerStub) {
  globalThis.__e2eSupabaseServerStub = true;
  const realFetch = globalThis.fetch;
  const log = process.env.E2E_SUPABASE_STUB_LOG;

  globalThis.fetch = async function fetchWithE2ESupabaseReads(input, init) {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== HOST) return realFetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const response = await answer(method, url, input, init);
    if (log) {
      try {
        appendFileSync(log, `${new Date().toISOString()} ${process.pid} ${response ? 'answered' : 'passed on'} ${method} ${url.pathname}${url.search}\n`);
      } catch {
        // The log is a convenience; the request is not.
      }
    }
    return response ?? realFetch(input, init);
  };
}
