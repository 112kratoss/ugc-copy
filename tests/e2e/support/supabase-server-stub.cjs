// The Supabase reads the E2E dev server answers itself, so that a spec can draw a page whose
// server render reads its data.
//
// The E2E run points the app at a placeholder project, https://example.supabase.co
// (playwright.config.ts), a host with no DNS record: every read the server makes fails,
// and a page that reads its data on the server draws its error state. The creator page,
// /creators/<name>, reads its creator in getCreatorProfileSummary (src/lib/creator-profile.ts).
// Playwright's page.route answers only the browser's requests. So the dev server loads this file
// (through dev-server.cjs, which playwright.config.ts preloads), where it wraps fetch: a request that matches
// one of READS below is answered here, before anything leaves the process, and every other
// request goes on as before. A page no spec draws through this file fails offline as it did.
//
// The data is one creator, owned by the E2E user (`workflow-user`, src/lib/e2e-auth.ts), who has
// published nothing: the profiles row in fixtures/creator-profile.json, which the specs read too. And
// two post pages': a text post with a free recipe, by a creator of its own
// (fixtures/post-with-recipe.json), and an image post made from a creation, with no recipe, by
// another creator of its own (fixtures/creation-post.json), and an image post made from a creation
// whose free recipe brings its Remix, by a third creator (fixtures/creation-post-free-recipe.json).
// And one post editor's: an image post of
// the E2E user's with one picture and no recipe (fixtures/post-composer-saved-twice.json). And
// Pricing's referral terms: no active program, which Pricing drew from the failed read too. And
// /api/search/suggest's two calls (its rate limit, by its scope, and its read, for one query:
// fixtures/search-suggestions.json), a route and not a page. And /api/search/starter's two
// (its rate limit, by its scope, and its read for a visitor: fixtures/search-starter.json). And the
// E2E user's recipe sales page, /marketplace/sell: two free recipes on text posts of theirs
// (fixtures/seller-recipes.json), with no unlock orders and no deleted posts.
// A page added here brings each of its reads, matched by method, path and the filters that name
// its own rows: a whole table answered with no rows would change what every other page draws.
//
//   E2E_SUPABASE_STUB_LOG=<file>  appends one line per request to the host, answered or passed on.
'use strict';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { appendFileSync } = require('node:fs');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const creator = require('../fixtures/creator-profile.json');
// A text post with a free recipe, by a creator of its own (not the E2E user, whose profile row the
// other pages read): the post page, /showcase/<id>, reads it in getPublicPostDetail
// (src/lib/public-posts.ts) and its recipe in getPostResourceBundleDetailByPostId.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const recipePost = require('../fixtures/post-with-recipe.json');
// An image post the E2E user owns, with one picture and no recipe: the post editor,
// /post/<id>/edit, reads it in getOwnerPostDetail (src/lib/owner-posts.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ownPost = require('../fixtures/post-composer-saved-twice.json');
// An image post made from a creation, with no recipe, by a creator of its own: its post page reads
// the post, its picture, its creator, its recipe (none) and its creation, whose settings the page
// shows under Made with (getPublicPostDetail, src/lib/public-posts.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const creationPost = require('../fixtures/creation-post.json');
// An image post made from a creation, with a published free recipe that comes with its Remix, by a
// creator of its own: the post page draws "Remix · Free" for a viewer who has not taken the recipe.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const freeRemixPost = require('../fixtures/creation-post-free-recipe.json');
// The E2E user's two free recipes, each on a text post of theirs: the older one unlocked five times,
// the newer one never. Recipe sales, /marketplace/sell, reads them in
// getSellerPostResourceBundleDashboard (src/lib/post-resource-bundles-server.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sellerRecipes = require('../fixtures/seller-recipes.json');
// What search_suggestions answers for one query, so that search-typeahead.spec.ts can send a
// request through the real proxy and the real /api/search/suggest and read the headers of its 200.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const searchSuggestions = require('../fixtures/search-suggestions.json');
// What search_starter answers a visitor, so that search-starter.spec.ts can send a request through
// the real proxy and the real /api/search/starter and read the headers of its 200.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const searchStarter = require('../fixtures/search-starter.json');
// In the order the page asks for them: its recipes' posts as its read lists the recipes, newest
// first, and the posts' covers as that read answers (the fixture's posts are in the same order).
const sellerPostIds = `in.(${sellerRecipes.bundles.map((bundle) => bundle.post_id).join(',')})`;
const sellerBundleIds = `in.(${sellerRecipes.bundles.map((bundle) => bundle.id).join(',')})`;

const HOST = 'example.supabase.co';

function json(body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

const READS = [
  {
    // GET /api/search/suggest: its own rate limit (enforceBackendRateLimit), allowed. Matched by the
    // scope, so every other route's limit still fails offline as it did.
    methods: ['POST'],
    path: '/rest/v1/rpc/check_backend_rate_limit',
    body: { p_scope: 'public-search:suggest' },
    answer: () => json({ allowed: true, limit: 120, remaining: 119, retryAfterSeconds: 0, resetAt: '2026-11-12T12:00:00.000Z' }),
  },
  {
    // ... and its one read (suggestSearch), for the one query the spec sends the real route.
    methods: ['POST'],
    path: '/rest/v1/rpc/search_suggestions',
    body: { p_query: searchSuggestions.query },
    answer: () => json(searchSuggestions.rows),
  },
  {
    // GET /api/search/starter: its own rate limit, allowed, matched by its scope ...
    methods: ['POST'],
    path: '/rest/v1/rpc/check_backend_rate_limit',
    body: { p_scope: 'public-search:starter' },
    answer: () => json({ allowed: true, limit: 60, remaining: 59, retryAfterSeconds: 0, resetAt: '2026-11-13T12:00:00.000Z' }),
  },
  {
    // ... and its one read, for a visitor (no viewer).
    methods: ['POST'],
    path: '/rest/v1/rpc/search_starter',
    body: { p_viewer_user_id: null },
    answer: () => json(searchStarter.rows),
  },
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
  {
    // fetchPublicPostRow: the post by id.
    methods: ['GET'],
    path: '/rest/v1/posts',
    filters: { id: `eq.${recipePost.post.id}` },
    answer: ({ wantsObject }) => json(wantsObject ? recipePost.post : [recipePost.post], { 'content-range': '0-0/1' }),
  },
  {
    // loadPostMediaItemsMap: a text post has none.
    methods: ['GET'],
    path: '/rest/v1/post_media',
    filters: { post_id: `in.(${recipePost.post.id})` },
    answer: () => json([], { 'content-range': '*/0' }),
  },
  {
    // loadPublicPostCreator.
    methods: ['GET'],
    path: '/rest/v1/profiles',
    filters: { id: `eq.${recipePost.creator.id}` },
    answer: ({ wantsObject }) => json(wantsObject ? recipePost.creator : [recipePost.creator], { 'content-range': '0-0/1' }),
  },
  {
    // The post's recipe.
    methods: ['GET'],
    path: '/rest/v1/post_resource_bundles',
    filters: { post_id: `eq.${recipePost.post.id}` },
    answer: ({ wantsObject }) => json(wantsObject ? recipePost.bundle : [recipePost.bundle], { 'content-range': '0-0/1' }),
  },
  {
    // hydrateBundleRows: the recipe's seller (loadProfileMap)...
    methods: ['GET'],
    path: '/rest/v1/profiles',
    filters: { id: `in.(${recipePost.creator.id})` },
    answer: () => json([recipePost.creator], { 'content-range': '0-0/1' }),
  },
  {
    // ...and the post it belongs to (loadLinkedPostMap).
    methods: ['GET'],
    path: '/rest/v1/posts',
    filters: { id: `in.(${recipePost.post.id})` },
    answer: () => json([recipePost.post], { 'content-range': '0-0/1' }),
  },
  {
    // fetchPublicPostRow: the creation post by id.
    methods: ['GET'],
    path: '/rest/v1/posts',
    filters: { id: `eq.${creationPost.post.id}` },
    answer: ({ wantsObject }) => json(wantsObject ? creationPost.post : [creationPost.post], { 'content-range': '0-0/1' }),
  },
  {
    // loadPostMediaItemsMap: its one picture, in the public bucket.
    methods: ['GET'],
    path: '/rest/v1/post_media',
    filters: { post_id: `in.(${creationPost.post.id})` },
    answer: () => json(creationPost.media, { 'content-range': `0-${creationPost.media.length - 1}/${creationPost.media.length}` }),
  },
  {
    // loadPublicPostCreator.
    methods: ['GET'],
    path: '/rest/v1/profiles',
    filters: { id: `eq.${creationPost.creator.id}` },
    answer: ({ wantsObject }) => json(wantsObject ? creationPost.creator : [creationPost.creator], { 'content-range': '0-0/1' }),
  },
  {
    // getPostResourceBundleDetailByPostId: no recipe.
    methods: ['GET'],
    path: '/rest/v1/post_resource_bundles',
    filters: { post_id: `eq.${creationPost.post.id}` },
    answer: () => json([], { 'content-range': '*/0' }),
  },
  {
    // loadPublicPostGeneration: the creation's model, and the settings its line reads, each under
    // its alias as PostgREST answers the paths the read selects (PUBLIC_GENERATION_SETUP_PATHS).
    methods: ['GET'],
    path: '/rest/v1/generations',
    filters: { id: `eq.${creationPost.post.generation_id}` },
    answer: ({ wantsObject }) => json(wantsObject ? creationPost.generation : [creationPost.generation], { 'content-range': '0-0/1' }),
  },
  {
    // fetchPublicPostRow: the creation post with a free recipe, by id.
    methods: ['GET'],
    path: '/rest/v1/posts',
    filters: { id: `eq.${freeRemixPost.post.id}` },
    answer: ({ wantsObject }) => json(wantsObject ? freeRemixPost.post : [freeRemixPost.post], { 'content-range': '0-0/1' }),
  },
  {
    // loadPostMediaItemsMap: its one picture, in the public bucket.
    methods: ['GET'],
    path: '/rest/v1/post_media',
    filters: { post_id: `in.(${freeRemixPost.post.id})` },
    answer: () => json(freeRemixPost.media, { 'content-range': `0-${freeRemixPost.media.length - 1}/${freeRemixPost.media.length}` }),
  },
  {
    // loadPublicPostCreator.
    methods: ['GET'],
    path: '/rest/v1/profiles',
    filters: { id: `eq.${freeRemixPost.creator.id}` },
    answer: ({ wantsObject }) => json(wantsObject ? freeRemixPost.creator : [freeRemixPost.creator], { 'content-range': '0-0/1' }),
  },
  {
    // getPostResourceBundleDetailByPostId: its free recipe.
    methods: ['GET'],
    path: '/rest/v1/post_resource_bundles',
    filters: { post_id: `eq.${freeRemixPost.post.id}` },
    answer: ({ wantsObject }) => json(wantsObject ? freeRemixPost.bundle : [freeRemixPost.bundle], { 'content-range': '0-0/1' }),
  },
  {
    // hydrateBundleRows: the recipe's seller (loadProfileMap)...
    methods: ['GET'],
    path: '/rest/v1/profiles',
    filters: { id: `in.(${freeRemixPost.creator.id})` },
    answer: () => json([freeRemixPost.creator], { 'content-range': '0-0/1' }),
  },
  {
    // ...and the post it belongs to (loadLinkedPostMap).
    methods: ['GET'],
    path: '/rest/v1/posts',
    filters: { id: `in.(${freeRemixPost.post.id})` },
    answer: () => json([freeRemixPost.post], { 'content-range': '0-0/1' }),
  },
  {
    // loadPublicPostGeneration: the creation's model and settings.
    methods: ['GET'],
    path: '/rest/v1/generations',
    filters: { id: `eq.${freeRemixPost.post.generation_id}` },
    answer: ({ wantsObject }) => json(wantsObject ? freeRemixPost.generation : [freeRemixPost.generation], { 'content-range': '0-0/1' }),
  },
  {
    // fetchOwnerPostRow: the post by id and owner. maybeSingle() asks for a list.
    methods: ['GET'],
    path: '/rest/v1/posts',
    filters: { id: `eq.${ownPost.post.id}`, user_id: `eq.${ownPost.post.user_id}` },
    answer: ({ wantsObject }) => json(wantsObject ? ownPost.post : [ownPost.post], { 'content-range': '0-0/1' }),
  },
  {
    // loadPostMediaItemsMap: its one picture.
    methods: ['GET'],
    path: '/rest/v1/post_media',
    filters: { post_id: `in.(${ownPost.post.id})` },
    answer: () => json(ownPost.media, { 'content-range': `0-${ownPost.media.length - 1}/${ownPost.media.length}` }),
  },
  {
    // loadSourceToolsMap: no Made with rows.
    methods: ['GET'],
    path: '/rest/v1/post_source_tools',
    filters: { post_id: `in.(${ownPost.post.id})` },
    answer: () => json([], { 'content-range': '*/0' }),
  },
  {
    // loadBundleMap: no recipe, in the compact summaries...
    methods: ['POST'],
    path: '/rest/v1/rpc/get_owner_post_bundle_summaries',
    body: { p_post_ids: [ownPost.post.id] },
    answer: () => json([]),
  },
  {
    // ...nor in the listing fields read beside them (loadBundleListingFields)...
    methods: ['GET'],
    path: '/rest/v1/post_resource_bundles',
    filters: { post_id: `in.(${ownPost.post.id})` },
    answer: () => json([], { 'content-range': '*/0' }),
  },
  {
    // ...nor in the editor's recipe (getPostResourceBundleDetailByPostId).
    methods: ['GET'],
    path: '/rest/v1/post_resource_bundles',
    filters: { post_id: `eq.${ownPost.post.id}` },
    answer: () => json([], { 'content-range': '*/0' }),
  },
  {
    // loadWelcomeCreditAmount: the welcome grant, which the creators tell a signed-out
    // visitor (creator-signed-out.spec.ts) and Home's shelf marks "Free to try" by.
    methods: ['GET'],
    path: '/rest/v1/credit_grant_programs',
    filters: { program_key: 'eq.welcome_credits_v1' },
    answer: ({ wantsObject }) => {
      const program = { amount: 25, enabled: true };
      return json(wantsObject ? program : [program], { 'content-range': '0-0/1' });
    },
  },
  {
    // readActiveReferralProgramTerms: the Invite & Earn terms Pricing's banner prints. No active
    // program leaves the numbers out, as the failed read did, without the 9 seconds that read
    // spent giving up on every Pricing a spec drew. maybeSingle() asks for a list.
    methods: ['GET'],
    path: '/rest/v1/referral_programs',
    filters: { status: 'eq.active' },
    answer: () => json([], { 'content-range': '*/0' }),
  },
  {
    // getSellerPostResourceBundleDashboard: the seller's recipes, newest first.
    methods: ['GET'],
    path: '/rest/v1/post_resource_bundles',
    filters: { owner_user_id: `eq.${sellerRecipes.bundles[0].owner_user_id}`, order: 'created_at.desc' },
    answer: () => json(sellerRecipes.bundles, { 'content-range': `0-${sellerRecipes.bundles.length - 1}/${sellerRecipes.bundles.length}` }),
  },
  {
    // hydrateBundleRows: their posts (loadLinkedPostMap)...
    methods: ['GET'],
    path: '/rest/v1/posts',
    filters: { id: sellerPostIds },
    answer: () => json(sellerRecipes.posts, { 'content-range': `0-${sellerRecipes.posts.length - 1}/${sellerRecipes.posts.length}` }),
  },
  {
    // ...whose covers a text post has none of (loadPostMediaItemsMap).
    methods: ['GET'],
    path: '/rest/v1/post_media',
    filters: { post_id: sellerPostIds },
    answer: () => json([], { 'content-range': '*/0' }),
  },
  {
    // loadSellerRecentUnlocks: no paid orders, in either of its two reads (sales and free opens).
    methods: ['GET'],
    path: '/rest/v1/post_resource_bundle_orders',
    filters: { bundle_id: sellerBundleIds, status: 'eq.paid' },
    answer: () => json([], { 'content-range': '*/0' }),
  },
  {
    // loadSellerDeletedSnapshots: no deleted post had a recipe.
    methods: ['GET'],
    path: '/rest/v1/post_deletion_audits',
    filters: { owner_user_id: `eq.${sellerRecipes.bundles[0].owner_user_id}`, bundle_access_mode: 'not.is.null' },
    answer: () => json([], { 'content-range': '*/0' }),
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
      // By their JSON, so that a list of ids (p_post_ids) matches the same list.
      if (!body || !Object.entries(read.body).every(([key, value]) => JSON.stringify(body[key]) === JSON.stringify(value))) continue;
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
