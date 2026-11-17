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
// whose free recipe brings its Remix, by a third creator (fixtures/creation-post-free-recipe.json),
// and one whose paid recipe locks its Remix at the recipe's price, by a fourth
// (fixtures/creation-post-paid-recipe.json), and a picture made elsewhere whose free recipe does not
// include the post's Remix, by a fifth (fixtures/upload-post-recipe-without-remix.json), and another
// of theirs whose recipe's stored remix switch is on (fixtures/upload-post-recipe-remix-switch-on.json).
// And one post editor's: an image post of
// the E2E user's with one picture and no recipe (fixtures/post-composer-saved-twice.json). And
// Pricing's referral terms: no active program, which Pricing drew from the failed read too. And
// whether a template is live, which the creators ask: none, as the failed read answered too. And
// /api/search/suggest's two calls (its rate limit, by its scope, and its read, for one query:
// fixtures/search-suggestions.json), a route and not a page. And /api/search/starter's two
// (its rate limit, by its scope, and its read for a visitor: fixtures/search-starter.json). And
// POST /api/search/opened's three (its rate limit, by its scope: allowed, but for one network
// address that has had its share; the day's visitor key; the insert of the opened result). And the
// E2E user's recipe sales page, /marketplace/sell: two free recipes on text posts of theirs
// (fixtures/seller-recipes.json), with no unlock orders and no deleted posts. And Explore's Recent
// lane for one tool of its own (/showcase?sort=recent&tool=e2e-explore-reel): three pictures by a
// creator of their own (fixtures/explore-reel.json), and the same lane for another tool
// (/showcase?sort=recent&tool=e2e-explore-load-more): thirty pictures, more than two pages
// (fixtures/explore-load-more.json, the rows built below). And the storefront, /marketplace: its first
// page, four free recipes on picture posts by a creator of their own and a fifth the page reads to
// know there are more (fixtures/marketplace-recipes.json). Both read the source tools catalog,
// answered with no rows (below), which they draw as the app's own list. And the E2E user's
// mature-content setting, on, which their profile's Mature content row draws (below). And the
// "Make this" shelf's pins, which the image, video and motion creators draw as "Start from a post"
// and the signed-out Home as its shelf: three pictures made in the app by a creator of their own
// (fixtures/creator-start-posts.json), with what a signed-in viewer's shelf reads of the E2E user
// (none of them hidden, reported or blocked).
// A page added here brings each of its reads, matched by method, path and the filters that name
// its own rows: a whole table answered with no rows would change what every other page draws.
//
//   E2E_SUPABASE_STUB_LOG=<file>  appends one line per request to the host, answered or passed on.
'use strict';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { appendFileSync } = require('node:fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createHash } = require('node:crypto');

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
// The same kind of post with a paid recipe, which locks its Remix at the recipe's price, by a creator
// of its own: post-page-signed-in-rail.spec.ts draws it for that creator and for another reader.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const paidRecipePost = require('../fixtures/creation-post-paid-recipe.json');
// A picture made elsewhere (no creation), whose free recipe holds a reference picture and does not
// include the post's Remix (`allow_remix` off): with no creation there is nothing to remix, and nobody
// is offered a Remix, its creator included. post-page-signed-in-rail.spec.ts draws it for that
// creator and for another reader.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const uploadRecipePost = require('../fixtures/upload-post-recipe-without-remix.json');
// Another picture of that creator's made elsewhere, its free recipe a reference picture with its
// stored remix switch on, which no read takes for a Remix since 2026-11-17 (the owner: "Yes, hide
// it"). post-page-no-remix-without-creation.spec.ts draws both for a visitor, a reader who has the
// recipe and their creator. Its creator's reads are the one above's.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const uploadRecipeSwitchOnPost = require('../fixtures/upload-post-recipe-remix-switch-on.json');
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
// Explore's Recent lane for one tool of its own, three pictures by a creator of their own: the grid,
// its reel and the way back to the grid (explore-reel-open.spec.ts). The lane is the one address
// whose posts read names the fixture (`source_tool_slug`), so no other page's read is answered.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const exploreReel = require('../fixtures/explore-reel.json');
// Explore's Recent lane for another tool of its own: thirty pictures by a creator of their own,
// more than two pages, so the grid loads more as it is scrolled (explore-load-more-steady.spec.ts).
// The fixture names the lane; its rows are built here, in the shape of explore-reel.json's.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const exploreLoadMore = require('../fixtures/explore-load-more.json');
const exploreLoadMorePosts = Array.from({ length: exploreLoadMore.postCount }, (_, index) => {
  const number = String(index + 1).padStart(2, '0');
  return {
    id: `${exploreLoadMore.postIdPrefix}${number}`,
    user_id: exploreLoadMore.creator.id,
    generation_id: null,
    visibility: 'public',
    output_url: null,
    showcase_asset_path: null,
    prompt: `A picture for the load-more lane, number ${number}.`,
    title: `${exploreLoadMore.titlePrefix}${number}`,
    body: '',
    category: 'image',
    creation_mode: null,
    post_format: 'media',
    save_count: 0,
    remix_count: 0,
    comment_count: 0,
    // Newest first, as the Recent lane orders them.
    created_at: new Date(Date.UTC(2026, 10, 3, 10, 0, 0) - index * 60_000).toISOString(),
    source_kind: 'external',
    source_tool: 'E2E Explore Load More',
    source_tool_slug: exploreLoadMore.toolSlug,
    review_status: 'visible',
    remixes_allowed: true,
    remix_parent_post_id: null,
    remix_parent_user_id: null,
    remix_origin_user_id: null,
    is_nsfw: false,
    archived_at: null,
  };
});
const exploreLoadMoreMedia = exploreLoadMorePosts.map((post, index) => {
  const number = String(index + 1).padStart(2, '0');
  const path = `${exploreLoadMore.creator.id}/load-more-${number}`;
  return {
    id: `e2e-load-more-cover-${number}`,
    post_id: post.id,
    storage_path: `${path}.png`,
    external_url: null,
    media_kind: 'image',
    content_type: 'image/png',
    original_name: `load-more-${number}.png`,
    width: 1080,
    height: 1350,
    duration_seconds: null,
    sort_order: 0,
    posts: { user_id: exploreLoadMore.creator.id },
    media_key: 'media-1',
    preview_storage_path: `${path}.preview.e2e10ad0.webp`,
    preview_thumbhash: null,
    preview_status: 'ready',
    preview_attempt_count: 1,
    preview_error: null,
    preview_generated_at: post.created_at,
    rendition_storage_path: null,
    rendition_status: 'skipped',
    rendition_attempt_count: 0,
    rendition_error: null,
    rendition_generated_at: null,
    rendition_bytes: null,
    teaser_storage_path: null,
    teaser_bytes: null,
    teaser_generated_at: null,
    teaser_error: null,
    source_unavailable_at: null,
    display_storage_path: `${path}.display.e2e10ad0.webp`,
  };
});
// The storefront's first page, newest first: four free recipes on picture posts and the fifth that
// says more follow, by one creator. /marketplace reads them in getMarketplaceResourceList
// (src/lib/post-resource-bundles-server.ts); marketplace-keeps-place.spec.ts draws it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const marketplaceRecipes = require('../fixtures/marketplace-recipes.json');
// The "Make this" shelf's pinned posts (HOME_SHELF_PINS, src/lib/home-shelf-lineup.ts, which
// e2e-smoke-readiness.test.ts holds the fixture's list to): three of the five answer, pictures made
// in the app by a creator of their own, each a creation on Nano Banana 2 whose remix is open to
// everyone. The creators read them as "Start from a post" (loadCreatorStartPosts), and Home as its
// shelf. Offline the read failed after supabase-js's three retries (1 + 2 + 4 s), and a creator
// page's document stayed open for those seven seconds on every navigation (2026-11-17);
// creator-arrival-steady.spec.ts draws the posts and their pictures.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const startPosts = require('../fixtures/creator-start-posts.json');
// In the order the page asks for them: its recipes' posts as its read lists the recipes, newest
// first, and the posts' covers as that read answers (the fixture's posts are in the same order).
const sellerPostIds = `in.(${sellerRecipes.bundles.map((bundle) => bundle.post_id).join(',')})`;
const sellerBundleIds = `in.(${sellerRecipes.bundles.map((bundle) => bundle.id).join(',')})`;
// The lane's posts as the hydration names them, in the order its read answered them.
const exploreReelPostIds = `in.(${exploreReel.posts.map(({ id }) => id).join(',')})`;
const exploreLoadMorePostIds = `in.(${exploreLoadMorePosts.map(({ id }) => id).join(',')})`;
const marketplacePostIds = `in.(${marketplaceRecipes.posts.map((post) => post.id).join(',')})`;
const marketplaceBundleIds = `in.(${marketplaceRecipes.bundles.map((bundle) => bundle.id).join(',')})`;
// The shelf reads its pins in their order, then hydrates the posts its read answered, in theirs.
const startPostPinIds = `in.(${startPosts.pinnedPostIds.join(',')})`;
const startPostIds = `in.(${startPosts.posts.map(({ id }) => id).join(',')})`;
const startPostGenerationIds = `in.(${startPosts.generations.map(({ id }) => id).join(',')})`;

const HOST = 'example.supabase.co';

// A visitor is counted by its hashed network address (hashFeedIdentity, src/lib/showcase-feed-identity.ts,
// with the salt the E2E server runs on). search-open-log.spec.ts sends one request as this address
// (x-vercel-forwarded-for), which the limit below refuses: the route's 429 shows its 204s were counted.
const SEARCH_OPENED_LIMITED_ADDRESS = '203.0.113.77';
const feedIdentitySalt = process.env.FEED_ANALYTICS_SALT || process.env.SUPABASE_SERVICE_ROLE_KEY || 'local-feed-identity-only';
const searchOpenedLimitedKey = createHash('sha256')
  .update(`${feedIdentitySalt}:network:${SEARCH_OPENED_LIMITED_ADDRESS}`)
  .digest('hex');

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
    // POST /api/search/opened: its own rate limit, spent for the one address above ...
    methods: ['POST'],
    path: '/rest/v1/rpc/check_backend_rate_limit',
    body: { p_scope: 'public-search:opened', p_subject_key: searchOpenedLimitedKey },
    answer: () => json({ allowed: false, limit: 120, remaining: 0, retryAfterSeconds: 30, resetAt: '2026-11-15T12:00:00.000Z' }),
  },
  {
    // ... and allowed for every other caller, matched by its scope ...
    methods: ['POST'],
    path: '/rest/v1/rpc/check_backend_rate_limit',
    body: { p_scope: 'public-search:opened' },
    answer: () => json({ allowed: true, limit: 120, remaining: 119, retryAfterSeconds: 0, resetAt: '2026-11-15T12:00:00.000Z' }),
  },
  {
    // ... the day's key for the visitor code (search_visitor_day_key), behind the answer ...
    methods: ['POST'],
    path: '/rest/v1/rpc/search_visitor_day_key',
    answer: () => json('e'.repeat(64)),
  },
  {
    // ... and the insert of the opened result, which PostgREST answers 201 with no body.
    methods: ['POST'],
    path: '/rest/v1/search_result_opens',
    answer: () => new Response(null, { status: 201 }),
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
    // fetchPublicPostRow: the creation post with a paid recipe, by id.
    methods: ['GET'],
    path: '/rest/v1/posts',
    filters: { id: `eq.${paidRecipePost.post.id}` },
    answer: ({ wantsObject }) => json(wantsObject ? paidRecipePost.post : [paidRecipePost.post], { 'content-range': '0-0/1' }),
  },
  {
    // loadPostMediaItemsMap: its one picture, in the public bucket.
    methods: ['GET'],
    path: '/rest/v1/post_media',
    filters: { post_id: `in.(${paidRecipePost.post.id})` },
    answer: () => json(paidRecipePost.media, { 'content-range': `0-${paidRecipePost.media.length - 1}/${paidRecipePost.media.length}` }),
  },
  {
    // loadPublicPostCreator.
    methods: ['GET'],
    path: '/rest/v1/profiles',
    filters: { id: `eq.${paidRecipePost.creator.id}` },
    answer: ({ wantsObject }) => json(wantsObject ? paidRecipePost.creator : [paidRecipePost.creator], { 'content-range': '0-0/1' }),
  },
  {
    // getPostResourceBundleDetailByPostId: its paid recipe.
    methods: ['GET'],
    path: '/rest/v1/post_resource_bundles',
    filters: { post_id: `eq.${paidRecipePost.post.id}` },
    answer: ({ wantsObject }) => json(wantsObject ? paidRecipePost.bundle : [paidRecipePost.bundle], { 'content-range': '0-0/1' }),
  },
  {
    // hydrateBundleRows: the recipe's seller (loadProfileMap)...
    methods: ['GET'],
    path: '/rest/v1/profiles',
    filters: { id: `in.(${paidRecipePost.creator.id})` },
    answer: () => json([paidRecipePost.creator], { 'content-range': '0-0/1' }),
  },
  {
    // ...and the post it belongs to (loadLinkedPostMap).
    methods: ['GET'],
    path: '/rest/v1/posts',
    filters: { id: `in.(${paidRecipePost.post.id})` },
    answer: () => json([paidRecipePost.post], { 'content-range': '0-0/1' }),
  },
  {
    // loadPublicPostGeneration: the creation's model and settings.
    methods: ['GET'],
    path: '/rest/v1/generations',
    filters: { id: `eq.${paidRecipePost.post.generation_id}` },
    answer: ({ wantsObject }) => json(wantsObject ? paidRecipePost.generation : [paidRecipePost.generation], { 'content-range': '0-0/1' }),
  },
  {
    // fetchPublicPostRow: the picture made elsewhere, by id. It has no creation to read.
    methods: ['GET'],
    path: '/rest/v1/posts',
    filters: { id: `eq.${uploadRecipePost.post.id}` },
    answer: ({ wantsObject }) => json(wantsObject ? uploadRecipePost.post : [uploadRecipePost.post], { 'content-range': '0-0/1' }),
  },
  {
    // loadPostMediaItemsMap: its one picture, in the public bucket.
    methods: ['GET'],
    path: '/rest/v1/post_media',
    filters: { post_id: `in.(${uploadRecipePost.post.id})` },
    answer: () => json(uploadRecipePost.media, { 'content-range': `0-${uploadRecipePost.media.length - 1}/${uploadRecipePost.media.length}` }),
  },
  {
    // loadPublicPostCreator.
    methods: ['GET'],
    path: '/rest/v1/profiles',
    filters: { id: `eq.${uploadRecipePost.creator.id}` },
    answer: ({ wantsObject }) => json(wantsObject ? uploadRecipePost.creator : [uploadRecipePost.creator], { 'content-range': '0-0/1' }),
  },
  {
    // getPostResourceBundleDetailByPostId: its free recipe, a reference picture.
    methods: ['GET'],
    path: '/rest/v1/post_resource_bundles',
    filters: { post_id: `eq.${uploadRecipePost.post.id}` },
    answer: ({ wantsObject }) => json(wantsObject ? uploadRecipePost.bundle : [uploadRecipePost.bundle], { 'content-range': '0-0/1' }),
  },
  {
    // hydrateBundleRows: the recipe's seller (loadProfileMap)...
    methods: ['GET'],
    path: '/rest/v1/profiles',
    filters: { id: `in.(${uploadRecipePost.creator.id})` },
    answer: () => json([uploadRecipePost.creator], { 'content-range': '0-0/1' }),
  },
  {
    // ...and the post it belongs to (loadLinkedPostMap).
    methods: ['GET'],
    path: '/rest/v1/posts',
    filters: { id: `in.(${uploadRecipePost.post.id})` },
    answer: () => json([uploadRecipePost.post], { 'content-range': '0-0/1' }),
  },
  {
    // fetchPublicPostRow: the second picture made elsewhere, its recipe's stored switch on. Its creator
    // is the one above, whose two profile reads answer for it too.
    methods: ['GET'],
    path: '/rest/v1/posts',
    filters: { id: `eq.${uploadRecipeSwitchOnPost.post.id}` },
    answer: ({ wantsObject }) => json(
      wantsObject ? uploadRecipeSwitchOnPost.post : [uploadRecipeSwitchOnPost.post],
      { 'content-range': '0-0/1' },
    ),
  },
  {
    // loadPostMediaItemsMap: its one picture, in the public bucket.
    methods: ['GET'],
    path: '/rest/v1/post_media',
    filters: { post_id: `in.(${uploadRecipeSwitchOnPost.post.id})` },
    answer: () => json(
      uploadRecipeSwitchOnPost.media,
      { 'content-range': `0-${uploadRecipeSwitchOnPost.media.length - 1}/${uploadRecipeSwitchOnPost.media.length}` },
    ),
  },
  {
    // getPostResourceBundleDetailByPostId: its free recipe, a reference picture, its switch on.
    methods: ['GET'],
    path: '/rest/v1/post_resource_bundles',
    filters: { post_id: `eq.${uploadRecipeSwitchOnPost.post.id}` },
    answer: ({ wantsObject }) => json(
      wantsObject ? uploadRecipeSwitchOnPost.bundle : [uploadRecipeSwitchOnPost.bundle],
      { 'content-range': '0-0/1' },
    ),
  },
  {
    // ...and the post it belongs to (loadLinkedPostMap; loadNsfwPostIds when the recipe is read
    // through its route).
    methods: ['GET'],
    path: '/rest/v1/posts',
    filters: { id: `in.(${uploadRecipeSwitchOnPost.post.id})` },
    answer: () => json([uploadRecipeSwitchOnPost.post], { 'content-range': '0-0/1' }),
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
    // hasLiveMediaTemplates (src/lib/live-media-templates.ts): whether /templates lists a template,
    // which every creator page waits for before it draws its ways into the catalog. None, which
    // leaves them out as the failed read did, the same on every run and without a failed read's
    // log line on every creator a spec draws (the read itself gives up after one try and at most
    // two seconds; 2026-11-17). Matched by its one-column select,
    // its limit of one and every one of the catalog's filters, so the catalog's own read, the
    // sitemap's and the poster repair's (hasRepairableTemplateDemoPosters, the same select and
    // limit) still fail offline as before.
    methods: ['GET'],
    path: '/rest/v1/templates',
    filters: {
      select: 'id',
      status: 'eq.active',
      is_active: 'eq.true',
      active_version_id: 'not.is.null',
      creator_user_id: 'not.is.null',
      limit: '1',
    },
    answer: () => json([], { 'content-range': '*/0' }),
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
  {
    // Explore's Recent lane for the fixture's tool (fetchPostRows, src/lib/showcase-feed.ts): its
    // three posts, newest first, in the filtered scan's one batch.
    methods: ['GET'],
    path: '/rest/v1/posts',
    filters: { source_tool_slug: `eq.${exploreReel.toolSlug}`, offset: '0' },
    answer: () => json(exploreReel.posts, { 'content-range': `0-${exploreReel.posts.length - 1}/${exploreReel.posts.length}` }),
  },
  {
    // resolvePostRowsToFeedItems: their pictures (loadPostMediaItemsMap), one each, in the public
    // bucket with a grid preview and a display copy, as the media workers leave them...
    methods: ['GET'],
    path: '/rest/v1/post_media',
    filters: { post_id: exploreReelPostIds },
    answer: () => json(exploreReel.media, { 'content-range': `0-${exploreReel.media.length - 1}/${exploreReel.media.length}` }),
  },
  {
    // ...their creator...
    methods: ['GET'],
    path: '/rest/v1/profiles',
    filters: { id: `in.(${exploreReel.creator.id})` },
    answer: () => json([exploreReel.creator], { 'content-range': '0-0/1' }),
  },
  {
    // ...no Made with rows...
    methods: ['GET'],
    path: '/rest/v1/post_source_tools',
    filters: { post_id: exploreReelPostIds },
    answer: () => json([], { 'content-range': '*/0' }),
  },
  {
    // ...none marked NSFW (loadNsfwPostIds)...
    methods: ['GET'],
    path: '/rest/v1/posts',
    filters: { id: exploreReelPostIds, select: 'id,is_nsfw' },
    answer: () => json(exploreReel.posts.map(({ id }) => ({ id, is_nsfw: false })), { 'content-range': `0-${exploreReel.posts.length - 1}/${exploreReel.posts.length}` }),
  },
  {
    // ...and no recipe, in the public summaries (getMarketplaceAssetSummaryHydration)...
    methods: ['POST'],
    path: '/rest/v1/rpc/get_public_post_resource_bundle_summaries',
    body: { p_post_ids: exploreReel.posts.map(({ id }) => id) },
    answer: () => json([]),
  },
  {
    // ...nor in which of them has a published recipe at all.
    methods: ['GET'],
    path: '/rest/v1/post_resource_bundles',
    filters: { post_id: exploreReelPostIds },
    answer: () => json([], { 'content-range': '*/0' }),
  },
  {
    // Explore's Recent lane for the load-more fixture's tool: all thirty posts in the filtered
    // scan's one batch (48), so every page of the lane, the first and each Load More, is cut from
    // them (collectFilteredFeedItems, src/lib/showcase-feed.ts).
    methods: ['GET'],
    path: '/rest/v1/posts',
    filters: { source_tool_slug: `eq.${exploreLoadMore.toolSlug}`, offset: '0' },
    answer: () => json(exploreLoadMorePosts, { 'content-range': `0-${exploreLoadMorePosts.length - 1}/${exploreLoadMorePosts.length}` }),
  },
  {
    // Their pictures, one each, as explore-reel.json's...
    methods: ['GET'],
    path: '/rest/v1/post_media',
    filters: { post_id: exploreLoadMorePostIds },
    answer: () => json(exploreLoadMoreMedia, { 'content-range': `0-${exploreLoadMoreMedia.length - 1}/${exploreLoadMoreMedia.length}` }),
  },
  {
    // ...their creator...
    methods: ['GET'],
    path: '/rest/v1/profiles',
    filters: { id: `in.(${exploreLoadMore.creator.id})` },
    answer: () => json([exploreLoadMore.creator], { 'content-range': '0-0/1' }),
  },
  {
    // ...no Made with rows...
    methods: ['GET'],
    path: '/rest/v1/post_source_tools',
    filters: { post_id: exploreLoadMorePostIds },
    answer: () => json([], { 'content-range': '*/0' }),
  },
  {
    // ...none marked NSFW...
    methods: ['GET'],
    path: '/rest/v1/posts',
    filters: { id: exploreLoadMorePostIds, select: 'id,is_nsfw' },
    answer: () => json(exploreLoadMorePosts.map(({ id }) => ({ id, is_nsfw: false })), { 'content-range': `0-${exploreLoadMorePosts.length - 1}/${exploreLoadMorePosts.length}` }),
  },
  {
    // ...and no recipe, in the public summaries...
    methods: ['POST'],
    path: '/rest/v1/rpc/get_public_post_resource_bundle_summaries',
    body: { p_post_ids: exploreLoadMorePosts.map(({ id }) => id) },
    answer: () => json([]),
  },
  {
    // ...nor in which of them has a published recipe at all.
    methods: ['GET'],
    path: '/rest/v1/post_resource_bundles',
    filters: { post_id: exploreLoadMorePostIds },
    answer: () => json([], { 'content-range': '*/0' }),
  },
  {
    // getMarketplaceResourceListBase: the storefront's first page (four, and one more to know more
    // follow), as the page and the list API ask for it.
    methods: ['POST'],
    path: '/rest/v1/rpc/list_marketplace_resource_bundles',
    body: {
      p_access_filter: 'all',
      p_resource_filter: 'all',
      p_tool_slug: null,
      p_query: null,
      p_sort: 'recent',
      p_offset: 0,
      p_limit: marketplaceRecipes.bundles.length,
    },
    answer: () => json(marketplaceRecipes.bundles),
  },
  {
    // hydrateRecipes: none of their posts is marked NSFW (loadNsfwPostIds)...
    methods: ['GET'],
    path: '/rest/v1/posts',
    filters: { select: 'id,is_nsfw', id: marketplacePostIds },
    answer: () => json(marketplaceRecipes.posts.map((post) => ({ id: post.id, is_nsfw: false }))),
  },
  {
    // ...their seller (loadProfileMap)...
    methods: ['GET'],
    path: '/rest/v1/profiles',
    filters: { id: `in.(${marketplaceRecipes.creator.id})` },
    answer: () => json([marketplaceRecipes.creator], { 'content-range': '0-0/1' }),
  },
  {
    // ...their posts (loadLinkedPostMap)...
    methods: ['GET'],
    path: '/rest/v1/posts',
    filters: { id: marketplacePostIds, review_status: 'eq.visible' },
    answer: () => json(marketplaceRecipes.posts, { 'content-range': `0-${marketplaceRecipes.posts.length - 1}/${marketplaceRecipes.posts.length}` }),
  },
  {
    // ...whose covers are one picture each, with its preview (loadPostMediaItemsMap)...
    methods: ['GET'],
    path: '/rest/v1/post_media',
    filters: { post_id: marketplacePostIds },
    answer: () => json(marketplaceRecipes.media, { 'content-range': `0-${marketplaceRecipes.media.length - 1}/${marketplaceRecipes.media.length}` }),
  },
  {
    // ...and no revision since the recipes went up (loadLatestContentRevisionTimes).
    methods: ['GET'],
    path: '/rest/v1/post_resource_bundle_revisions',
    filters: { bundle_id: marketplaceBundleIds },
    answer: () => json([], { 'content-range': '*/0' }),
  },
  {
    // listSourceToolsCatalog (src/lib/source-tools-server.ts), which Explore's server render waits
    // for beside the feed and the storefront's render reads beside its first page: no rows, so the
    // catalog is the app's own fallback list, as it is where the table is missing. Answered without
    // a fixture row, as the welcome grant and the referral terms are, because the other pages the
    // specs draw that read it draw the same as its failure did: Explore's other lanes fail on their
    // own feed reads first ("Could not load Explore"), and the post composer, which asks for it
    // through /api/source-tools, is answered that call by its specs, but for the media reorder's and
    // bottom-nav-overlays' signed-in /post/new, which never open the list (2026-11-16).
    methods: ['GET'],
    path: '/rest/v1/source_tools',
    filters: { is_active: 'eq.true' },
    answer: () => json([], { 'content-range': '*/0' }),
  },
  {
    // loadMatureContentPreference (src/app/profile/load-mature-content-preference.ts): the E2E
    // user's mature-content setting, on, which the profile's Mature content row draws from its first
    // frame (profile-mature-setting-first-paint.spec.ts). Answered without a fixture row: no other
    // page reads the table on the server, and /api/content-preferences refuses the E2E user offline
    // before its own read (its identity check fails), so nothing else draws differently.
    // maybeSingle() asks for a list.
    methods: ['GET'],
    path: '/rest/v1/content_preferences',
    filters: { user_id: 'eq.workflow-user', select: 'show_mature' },
    answer: ({ wantsObject }) => json(wantsObject ? { show_mature: true } : [{ show_mature: true }], { 'content-range': '0-0/1' }),
  },
  {
    // The shelf's build (buildHomeShelfCreations, src/lib/home-shelf-server.ts) reads its pins as the
    // feed does (getShowcaseFeedItemsByPostIds): public and not archived. Three of the five answer.
    methods: ['GET'],
    path: '/rest/v1/posts',
    filters: { id: startPostPinIds, visibility: 'eq.public', archived_at: 'is.null' },
    answer: () => json(startPosts.posts, { 'content-range': `0-${startPosts.posts.length - 1}/${startPosts.posts.length}` }),
  },
  {
    // resolvePostRowsToFeedItems: their pictures, one each, with a grid preview, as the media workers
    // leave them...
    methods: ['GET'],
    path: '/rest/v1/post_media',
    filters: { post_id: startPostIds },
    answer: () => json(startPosts.media, { 'content-range': `0-${startPosts.media.length - 1}/${startPosts.media.length}` }),
  },
  {
    // ...their creator...
    methods: ['GET'],
    path: '/rest/v1/profiles',
    filters: { id: `in.(${startPosts.creator.id})` },
    answer: () => json([startPosts.creator], { 'content-range': '0-0/1' }),
  },
  {
    // ...no Made with rows...
    methods: ['GET'],
    path: '/rest/v1/post_source_tools',
    filters: { post_id: startPostIds },
    answer: () => json([], { 'content-range': '*/0' }),
  },
  {
    // ...none marked NSFW...
    methods: ['GET'],
    path: '/rest/v1/posts',
    filters: { id: startPostIds, select: 'id,is_nsfw' },
    answer: () => json(startPosts.posts.map(({ id }) => ({ id, is_nsfw: false }))),
  },
  {
    // ...no recipe, in the public summaries...
    methods: ['POST'],
    path: '/rest/v1/rpc/get_public_post_resource_bundle_summaries',
    body: { p_post_ids: startPosts.posts.map(({ id }) => id) },
    answer: () => json([]),
  },
  {
    // ...nor in which of them has a published recipe at all...
    methods: ['GET'],
    path: '/rest/v1/post_resource_bundles',
    filters: { post_id: startPostIds },
    answer: () => json([], { 'content-range': '*/0' }),
  },
  {
    // ...and their creations: the card's model (loadGenerationPreviewInfoMap) and the settings its
    // remix opens on, which the shelf prices on the code catalog (loadGenerations), in both reads.
    methods: ['GET'],
    path: '/rest/v1/generations',
    filters: { id: startPostGenerationIds },
    answer: () => json(startPosts.generations, { 'content-range': `0-${startPosts.generations.length - 1}/${startPosts.generations.length}` }),
  },
  {
    // A signed-in viewer's shelf leaves out what the feed leaves out for them (loadViewerRelations,
    // src/lib/showcase-feed-personalization.ts). The E2E user has marked none of the posts Not
    // interested...
    methods: ['GET'],
    path: '/rest/v1/feed_user_post_feedback',
    filters: { user_id: 'eq.workflow-user', post_id: startPostIds },
    answer: () => json([], { 'content-range': '*/0' }),
  },
  {
    // ...hidden none of their creator's...
    methods: ['GET'],
    path: '/rest/v1/feed_user_creator_feedback',
    filters: { user_id: 'eq.workflow-user', creator_user_id: `in.(${startPosts.creator.id})` },
    answer: () => json([], { 'content-range': '*/0' }),
  },
  {
    // ...reported none...
    methods: ['GET'],
    path: '/rest/v1/post_reports',
    filters: { reporter_user_id: 'eq.workflow-user', post_id: startPostIds },
    answer: () => json([], { 'content-range': '*/0' }),
  },
  {
    // ...and neither has blocked the other (loadBlockedCreatorIds), asked both ways.
    methods: ['GET'],
    path: '/rest/v1/user_blocks',
    filters: { blocker_user_id: 'eq.workflow-user', blocked_user_id: `in.(${startPosts.creator.id})` },
    answer: () => json([], { 'content-range': '*/0' }),
  },
  {
    methods: ['GET'],
    path: '/rest/v1/user_blocks',
    filters: { blocked_user_id: 'eq.workflow-user', blocker_user_id: `in.(${startPosts.creator.id})` },
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
