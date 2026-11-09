# Magicbooklet MCP server — build plan

Status, 2026-11-10: phases 0 to 3 are shipped and live. Phase 1 is PR #747, phase 2 PR #749 and
phase 3 PR #748; the last release reached production on 2026-11-09 at 20:24 UTC, the tools, the
setup page and Connected apps were checked there the same hour (runbook, "Production switch-on
checks"), and the registry entry `com.magicbooklet/mcp` 1.1.0 was published at 20:28 UTC. Phase 4
(an agent posts media made elsewhere; the owner asked for it on 2026-11-10) is built and in
review on `feat/mcp-outside-media`: server 1.2.0, twelve tools, proven on a local stack; it is
not live until its PR is merged and released, and the registry keeps 1.1.0 until then. The plan
stays in `plans/` for what is still open: phase 4's merge, production check and registry publish,
ChatGPT's client (after the owner creates its connector), a first run and a first new post made
through an agent (the owner's to start; that post is then reviewed in the moderation queue), the
owner's two submissions (the Anthropic directory exception and the ChatGPT directory; runbook,
"Distribution"), one real Codex sign-in, retention for `agent_tool_calls`, and `run_template`
after a usage check.

Decided on 2026-11-09 after the competitor analysis in
[`../research/agent-mcp-competitor-analysis-2026-11-09.md`](../research/agent-mcp-competitor-analysis-2026-11-09.md).
Phase 0 ran the same day and came back GO: every check and its result is in
[`../research/mcp-oauth-spike-2026-11-09.md`](../research/mcp-oauth-spike-2026-11-09.md).

## What we build

A remote MCP server at `https://magicbooklet.com/api/mcp` that lets an agent (Claude.ai,
Claude Desktop, Claude Code, ChatGPT, Codex, Cursor) do the product's two jobs as a signed-in
Magicbooklet creator:

1. **Create media** — pick a model, get a free quote, start a run with the creator's own
   credits, wait for the result.
2. **Publish** — turn a finished creation into a post on the creator's profile and the showcase,
   with the recipe and remix rules the app applies. Since phase 4 the post can also be made of
   media the person made elsewhere, staged by the agent and published through the composer's own
   path.

Authorization is OAuth 2.1 through Supabase Auth's OAuth server, so the agent holds an ordinary
Supabase user token: every existing service, RLS policy and rate limit applies unchanged. No
mobile change; nothing ships over the air.

## Decisions

The four questions the research left open, answered as the owner asked ("decide the open
questions and plan the build", 2026-11-09). Each is a recommendation the owner can overturn.

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Credit confirmation | **Quote, then create.** `create_media` requires `expected_cost_credits`; the start service already refuses to charge above the price shown (`unified-generation-start-service.ts`, "never charged more than that"), so a drifted price comes back as `COST_CHANGED` with the fresh quote and the agent confirms again. `create_media` also carries `destructiveHint: true`, but the spike found that Claude Code's permission prompts ignore tool annotations, so the required `expected_cost_credits` is the guard and the hint is only a label. `quote_generation` is free and returns `affordable`. | Krea's `preflight` and fal's "each submit bills" pattern, with no server state of our own. |
| 2 | Publish default | **Live by default**, `visibility` of `public` or `private` (the publish service's own values). Guards: the existing publish limit (20 per 10 min), a new agent cap of 10 public posts per account per day, the moderation queue as for any post, and an audit row per agent call so moderation can list and revert agent posts. Publishing the same generation twice returns its existing post (the service already treats a second publish as a republish). | Publishing is the differentiator nobody has; a draft-only default would make the second job a dead end. The caps and the audit trail are what make live acceptable. |
| 3 | Gating | **Registered accounts, any plan.** The consent page refuses a guest session, and the route refuses an anonymous token even if one arrives. Credits are the only gate, as on the web. | Guests exist for checkout; an agent acting as a guest would create media nobody can find again. |
| 4 | Templates | **Not in v1.** `run_template` is a phase-3 candidate once template usage is checked (owner's rule: check usage before offering parity). | Keep v1 to the two jobs the owner named. |

Decisions the plan adds:

- **Supabase Auth is the authorization server.** Production already signs ES256 (its JWKS is
  live), so the proxy's `getClaims()` verification works for agent tokens as it does for app
  tokens. The server is off today (`/.well-known/oauth-authorization-server` answers
  `feature_disabled`); `supabase/config.toml` already carries the block with
  `authorization_url_path = "/oauth/consent"` and dynamic registration off.
- **Pre-registered clients first, dynamic registration only if the spike needs it.** Claude Code
  takes a pre-registered client id and a fixed callback port
  (`claude mcp add --transport http --client-id … --callback-port …`), and Claude.ai, Claude
  Desktop and ChatGPT take a client id and secret in their connector forms. The spike confirmed both
  paths on GoTrue 2.186: redirect URIs match exactly (no port-agnostic loopback), and dynamic
  registration works for a zero-config Claude Code, Codex or Cursor at the cost of a client row per
  install. Production starts with registration off and one public client per surface; phase 3
  reconsiders.
- **Agent tokens drive only the MCP route of this app.** Supabase cannot bind a token to our
  resource (no RFC 8707 support), so the route requires the `client_id` claim an OAuth-issued
  token carries, the proxy refuses a `client_id`-bearing token on every other `/api` route, and
  the server-rendered pages refuse it as a session. Against Supabase directly the token is still
  the creator's session under RLS, like any user token; revocation (Connected apps) and the
  one-hour expiry are the remedy for a leak.
- **No scope-based authorization.** The token has no scope claim; the consent screen shows a
  fixed description of what the agent may do, and the server authorizes per tool by the user.
- **Stateless Streamable HTTP, JSON responses, no sessions, no Redis.** The MCP server SDK v2
  (`@modelcontextprotocol/server` 2.4.0, zod 4.3.6); the route exports `maxDuration = 60`. Long
  work never blocks: `create_media` returns a generation id, `get_generation` polls with an
  optional bounded wait. Phase 1 note (2026-11-09): Vercel's `mcp-handler` 2.3.1 worked in the
  spike but was left out of the build, because it gives the SDK no way to answer 2025-era clients
  (every client today) with JSON bodies: its stateless legacy leg streams each answer over SSE,
  which the spike saw too (`text/event-stream` with one `data:` line). The adapter wires the SDK's
  web-standard transport directly (`sessionIdGenerator: undefined`, `enableJsonResponse: true`)
  and sends a 2026-07-28 envelope to the SDK's handler for that revision.
- **No credit selling in tool output.** A short balance answers "insufficient credits" with the
  balance and the shortfall, never a purchase link (ChatGPT's directory forbids selling or
  upselling credits in-app; it keeps the Anthropic and ChatGPT paths equal).

## What is already there

- Route → adapter → service layering; `route-identity-policy.ts` registers every API route and
  its test fails on an unlisted one. The proxy matcher covers `/api/:path*` but not
  `/.well-known/*` (`src/proxy.ts:313`), and the policy test scans `src/app/api` only.
- Admission (`route-identity-admission.ts`): `getClaims()` against the JWKS, lifecycle check
  (merged, deleting), `is_anonymous` → 403 `REGISTRATION_REQUIRED` on registered routes, then a
  signed assertion header the services trust. `/api/showcase/feed` already runs this at the route
  (`regional-identity-admission.ts`), which is the pattern the MCP route copies.
- Services the tools call, unchanged:
  - catalog: `readModelCatalogPage`, `readModelCatalogDetails` (`model-catalog-read-service.ts`);
  - quote: `generation-model-quote-service.ts`;
  - start: `postUnifiedGenerationForRoute` → `unified-generation-start-service.ts` (body:
    `kind, modelId, catalogRevision, settings, prompt, shots, inputs[], expectedCostCredits`;
    idempotency by the `idempotency-key` header or `idempotencyKey` in the body;
    `MEDIA_GENERATION_RATE_LIMIT` 30 per 10 min);
  - read: `listOwnerGenerationsForRoute` (`id=`, `ids=`, `detail=summary|status`, cursor paging);
  - publish: `publishGenerationToShowcaseForRoute` (`ShowcasePublishRequestBody`: `generationId,
    title, description, body, category, visibility, isNsfw, allowRemixes, …`;
    `SHOWCASE_PUBLISH_RATE_LIMIT` 20 per 10 min; refuses guests; republish returns the post);
  - delete: `post-delete-service.ts`; enhance: `prompt-enhancement-route-adapter-service.ts`;
  - uploads: sign (`temporary-media-upload-sign.ts`), byte reservations, finalize
    (`upload-finalization.ts`); `toStorageUploadBody` wraps bytes in a Blob.
- supabase-js 2.108.2 has the OAuth server client API: `auth.oauth.getAuthorizationDetails`,
  `approveAuthorization`, `denyAuthorization`, `listGrants`, `revokeGrant`.
- `/api/posts` already runs with `maxDuration = 300` and fluid compute is on (`vercel.json`), so
  a 60 s MCP function is within the plan.
- `next.config.ts` traces ffmpeg and libvips per route (`outputFileTracingIncludes`); a route
  that reaches the start or publish services without an entry 500s at runtime with a green
  build. `/api/mcp` needs the entry.

## Architecture

### Authorization flow

```
agent → POST /api/mcp (no token)
      ← 401, WWW-Authenticate: Bearer resource_metadata="https://magicbooklet.com/.well-known/oauth-protected-resource/api/mcp"
agent → GET  /.well-known/oauth-protected-resource/api/mcp
      ← { resource: "https://magicbooklet.com/api/mcp", authorization_servers: ["https://<ref>.supabase.co/auth/v1"], bearer_methods_supported: ["header"] }
agent → GET  https://<ref>.supabase.co/auth/v1/.well-known/oauth-authorization-server
browser → /auth/v1/oauth/authorize?client_id&redirect_uri&code_challenge…   (PKCE S256)
        ← 302 https://magicbooklet.com/oauth/consent?authorization_id=…
consent page: no session → /login?next=/oauth/consent?…; guest session → sign-in wall;
              account → shows the client and the fixed access list → approveAuthorization()
        ← 302 <client redirect_uri>?code=…&state=…
agent → POST /auth/v1/oauth/token (code + verifier)
      ← Supabase JWT (ES256, sub, client_id, is_anonymous=false, 1 h) + refresh token
agent → POST /api/mcp, Authorization: Bearer <jwt>
```

### Admission at the route

`/api/mcp` is registered as `registered` in `route-identity-policy.ts`, and the proxy skips it
the way it skips the feed read: `regional-identity-admission.ts` becomes the general
"route-owned admission" list (`/api/showcase/feed` GET/HEAD, `/api/mcp` all methods). The route
runs `evaluateUserFacingRouteIdentity` itself and:

- answers a missing or invalid token 401 with the `WWW-Authenticate` header above (the proxy's
  own 401 has no header, and the MCP clients need it);
- answers a guest 403 `REGISTRATION_REQUIRED` as the proxy would;
- requires the `client_id` claim (403 `AGENT_TOKEN_REQUIRED` otherwise, so a copied app session
  cannot drive the server);
- builds the admitted request with `createAdmittedIdentityHeaders(…, 'route')` and hands it to
  `createUserClient`, so every service sees the same trusted assertion it sees behind the proxy.

The proxy gains one rule: a token with a `client_id` claim on any other `/api` route is refused
403 `AGENT_TOKEN_NOT_ALLOWED`.

A kill switch, `MCP_SERVER_DISABLED=1`, answers 503 with `Retry-After` before admission.

### Tool surface

| Tool | Job | Annotations | Backed by | Limits |
|---|---|---|---|---|
| `list_models` | create | read-only | `readModelCatalogPage` (web projection), filter by `kind` | — |
| `get_model` | create | read-only | `readModelCatalogDetails`: settings, inputs, price rules | — |
| `quote_generation` | create | read-only | quote service; returns `cost`, `balance`, `affordable`, `catalog_revision` | free |
| `upload_input` | both | `openWorldHint` | fetch an `https` URL (public hosts only, size and type checks), decode base64, or (phase 4) finalize an upload the agent sent itself (`upload_id`) → staging upload → finalize; returns an input reference a run or a post takes | as built: 25 MB picture, 50 MB clip or track by URL; 3 MB base64; 30 per 10 min |
| `request_upload` (phase 4) | both | — | the web's sign step for a file on the agent's machine; answers the signed URL, the headers and the curl line that PUTs it | the URL caps; shares `upload_input`'s 30 per 10 min; four uploads open per account |
| `create_media` | create | `destructiveHint` | `postUnifiedGenerationForRoute` with `expected_cost_credits` required and `idempotency_key` passed through | existing 30 per 10 min |
| `get_generation` | create | read-only | `listOwnerGenerationsForRoute` by id; `wait_seconds` 0–45 polls every 3 s | ≤ 45 s |
| `list_creations` | both | read-only | `listOwnerGenerationsForRoute` summaries, `posted` flag, cursor | page ≤ 50 |
| `publish_post` | publish | `openWorldHint` | one of two sources: `generation_id` → `publishGenerationToShowcaseForRoute`, own completed generation only; `uploads` (phase 4) → the composer's `createOwnerPostForRoute`, 1 to 5 staged files with a title and `made_with` | existing 20 per 10 min + agent 10 public posts per UTC day (+ the post-mutation limit for uploads) |
| `get_post` | publish | read-only | the post page's loader: state, URL, counts | — |
| `delete_post` | publish | `destructiveHint` | `post-delete-service.ts`, own posts only | existing post-mutation limit |
| `enhance_prompt` | create | read-only | prompt enhancement service | existing 60 per 10 min |

Every tool has a `title`, a one-paragraph description written for an agent (when to call it, what
to do with the result), and a zod input schema; a test walks the registry and holds each tool to
a title, a description, annotations and a schema.

### Results

- `structuredContent` plus a short text block in every result (clients without structured
  output still read it).
- `get_generation` of a finished image also returns an `image` content block from the existing
  preview asset (≤ 1 MB) so Claude Code and Claude.ai show it inline; a video returns its poster
  and a signed media URL beside the permanent `magicbooklet.com` link.
- Results stay under 100k characters; lists page rather than grow.
- Errors are tool results with `isError: true`, a stable `code` (`INSUFFICIENT_CREDITS`,
  `COST_CHANGED`, `RATE_LIMITED`, `NOT_OWNER`, `NOT_READY`, …) and the next step in words.

### Safety

- Consent, revocation (Connected apps on the profile), the `client_id` rules, the kill switch.
- Credits: quote-then-create, idempotency, the existing refund-on-failure path.
- Feed: the agent daily cap, the audit table, moderation can filter to agent posts.
- Uploads by URL fetch only public hosts (no private ranges, no redirects off-host), with the
  existing byte caps and MIME allow-list.
- Media made elsewhere (phase 4): only a file staged through `upload_input` is published, so the
  signature rule has seen every file; the composer's own rules, limits and ownership check decide
  the post; Made with is required, never Magicbooklet's own name and never a new catalog row; the
  consent screen says an agent may bring pictures and videos from elsewhere.
- Logging: one `logBackendEvent` per tool call with `client_id`, tool, outcome and cost; the
  audit table is the queryable record.

## Phases

Each phase is one PR off `main`, reviewed at `max` (sign-in and route admission make every
phase risky by the AGENTS.md rule) by a single reviewer session (owner, 2026-11-04), after the
local gate. Web deploys through `production-release.yml`; no mobile change in any phase.

### Phase 0 — spike (one session, local stack, nothing merged)

Goal: prove the authorization path end to end before writing product code.

1. `[auth.oauth_server] enabled = true` in `supabase/config.toml`, `npx supabase start`.
2. Create a public client with `supabase.auth.admin.oauth.createClient({ name, redirect_uris:
   ['http://localhost:<port>/callback'], client_type: 'public' })` against the local stack.
3. A throwaway `/api/mcp` with one `whoami` tool and the consent page's skeleton.
4. `claude mcp add --transport http --client-id <id> --callback-port <port> magicbooklet-local
   http://localhost:3000/api/mcp`, then `/mcp` → sign in → approve → call `whoami`.

Checks, each recorded with its result:

- token claims (`client_id`, `is_anonymous`, `aud`, expiry) and `createUserClient` reads under
  RLS with that token; refresh works;
- `getAuthorizationDetails` returns an `OAuthRedirect` on a second consent (auto-approve), and
  `listGrants` / `revokeGrant` exist on the running Auth version (local image and production
  may differ; production's version is read from `/auth/v1/health` with the anon key);
- with `allow_dynamic_registration = true`: does Claude Code's random loopback port register and
  redirect? This decides the Codex and Cursor path;
- the `resource` parameter clients send (ChatGPT, Claude) is ignored, not rejected;
- Claude Code's `destructiveHint` prompt appears for `whoami` marked destructive;
- which exact redirect URIs Claude.ai, Claude Desktop, ChatGPT, Codex and Cursor present
  (read from their docs or the local Auth log on a failed exchange).

Output: the research note named at the top, with the go or no-go for Supabase as the
authorization server. Result, 2026-11-09: GO. The conditions it set — lifecycle admission rather
than a signature check (revocation shows up as `session_valid: false`, not as an invalid
signature), the `client_id` requirement, the guest refusal on the consent page (GoTrue lets a
guest approve), exact redirect URIs, and production checks of the three discovery URLs and the
no-`apikey` token endpoint — are folded into phase 1 below. The fallback (an authorization
server of our own) is not needed.

### Phase 1 — the server and job 1 (create media)

Add:

- `src/app/api/mcp/route.ts` — `runtime = 'nodejs'`, `maxDuration = 60`, handlers from the
  adapter.
- `src/lib/mcp-route-adapter-service.ts` — kill switch, route-owned admission, the 401/403
  shapes with `WWW-Authenticate`, the `client_id` requirement, `createMcpHandler` wiring.
- `src/lib/mcp-server-service.ts` — the tool registry: schemas, annotations, handlers for
  `list_models`, `get_model`, `quote_generation`, `create_media`, `get_generation`,
  `list_creations`, `enhance_prompt`.
- `src/lib/mcp-tool-results.ts` — result shaping and caps.
- `src/app/.well-known/oauth-protected-resource/route.ts` and
  `src/app/.well-known/oauth-protected-resource/api/mcp/route.ts` — RFC 9728 metadata with
  CORS, built by `src/lib/oauth-protected-resource-metadata.ts` from `NEXT_PUBLIC_SITE_URL`
  and `NEXT_PUBLIC_SUPABASE_URL`.
- `src/app/oauth/consent/page.tsx` (+ client component) and `src/lib/oauth-consent-service.ts`
  — the consent screen: client name, the fixed access list, approve and deny, the guest wall,
  the sign-in redirect through `/login?next=`.
- `docs/mcp-server-operations.md` — enabling the OAuth server, creating clients and their
  redirect URIs, the kill switch, reading the logs; indexed in `docs/README.md` and the AGENTS.md
  runbook list.

Change:

- `route-identity-policy.ts` (`/api/mcp` → `registered`), `regional-identity-admission.ts` →
  route-owned admission for both paths, `src/proxy.ts` (skip the MCP route, refuse `client_id`
  tokens elsewhere).
- `next.config.ts` — `/api/mcp` in the ffmpeg and sharp tracing list.
- `.env.example` — `MCP_SERVER_DISABLED` (the E2E readiness test requires every read name).
- `supabase/config.toml` — `enabled = true` for the local stack.
- `package.json` — `mcp-handler`, the MCP server SDK (exact versions from the spike).
- AGENTS.md — an "Agent access (MCP)" paragraph under Architecture; `.claude/rules/web-mobile-contract.md` — the route-owned admission of `/api/mcp`.

Tests (`src/__tests__/`): `mcp-route-adapter-service.test.ts` (401 header, 503 kill switch,
guest 403, `client_id` requirement, admitted request carries the assertion),
`mcp-server-service.test.ts` (each tool against mocked services, the registry walk, result
caps, `COST_CHANGED` round trip), `oauth-protected-resource-metadata.test.ts`,
`oauth-consent-service.test.ts`, the policy and admission tests' new entries, a proxy test for
the `client_id` refusal; `tests/e2e/`: the metadata document and the unauthenticated 401.

Owner's steps: enable the OAuth server in the production dashboard (Authentication → OAuth
Server, authorization path `/oauth/consent`), create the OAuth Apps for Claude Code (public,
fixed port) and Claude.ai / Claude Desktop (redirect `https://claude.ai/api/mcp/auth_callback`),
and connect once from each.

### Phase 2 — job 2 (publish) and inputs

Status: shipped in PR #749 and live since 2026-11-09 20:24 UTC (the four tools, the
`agent_tool_calls` migration and its audit write, `AGENT_PUBLISH_RATE_LIMIT`, Connected apps on
`/profile/edit`, the moderation filter, image blocks); the owner's steps below are open. The post
page is `/showcase/<id>`, so `post_url` names that, not `/post/<id>`. As built, the cap counts
public publications per UTC day from the audit table, not attempts, and `upload_input` takes
25 MB for a picture and 50 MB for a clip by URL, or 3 MB by base64 (runbook).

- `publish_post`, `get_post`, `delete_post`, `upload_input` in the registry.
- Migration `agent_tool_calls` (id, user_id, client_id, tool, ok, generation_id, post_id,
  cost_credits, created_at; owner-read RLS; service-role write) with its `*-migration.test.ts`
  and pgTAP; the audit write in the adapter.
- `AGENT_PUBLISH_RATE_LIMIT` (10 per UTC day) in `backend-rate-limit.ts`.
- Connected apps on `/profile/edit`: `listGrants` and `revokeGrant`.
- Moderation: `ops:moderation -- list --source agent` (joins the audit table; the CLI must stay
  loadable under tsx, no server-only imports).
- Image content blocks in `get_generation`.

Owner's steps: the ChatGPT connector (confidential client, redirect from the spike), a first
agent-published post reviewed in the moderation queue.

### Phase 3 — distribution

Status, 2026-11-10: shipped in PR #748 and live: the setup page, the plugin marketplace with two
skills, the registry entry and its `/.well-known/mcp-registry-auth` proof, and
`resource_documentation` restored. Dynamic registration stays off; Codex and Cursor use
pre-registered public clients (runbook, "Distribution", which also has the Codex redirect URI
Codex derives). The production clients for Claude, Claude Code, Cursor and Codex were registered
on 2026-11-09, and the Codex client gained that derived redirect on 2026-11-10 (runbook,
"Registered clients"). Phase 2 (#749) merged first and #748 took it in, so the page's and the
skills' publishing and Connected apps went live with its release, and the registry
entry is version 1.1.0, the server's, published to the registry on 2026-11-09 at 20:28 UTC
(runbook, "MCP registry"). Left: ChatGPT's client (after its connector), one real Codex sign-in
(runbook, switch-on check 5), the owner's steps below, and `run_template`, still waiting for its
usage check.

- `src/app/developers/mcp/page.tsx` — the setup page: one command or form per client, what the
  agent can do, how to revoke.
- A Claude Code plugin marketplace in this public repo (`.claude-plugin/marketplace.json`,
  `plugins/magicbooklet/` declaring the `"type": "http"` server in its `plugin.json`, since the
  repo's agent guard refuses every `.mcp.json`, and skills such as a UGC-ad flow that
  chains quote → create → wait → publish), installed with `claude plugin marketplace add`.
- Official MCP registry entry `com.magicbooklet/mcp` (`/.well-known/mcp-registry-auth` or a DNS
  TXT record).
- Codex and Cursor setup per the spike's finding (dynamic registration on, or documented
  pre-registered clients).
- `run_template` only after a usage check.

Owner's steps: the written-exception request to mcp-review@anthropic.com for the Anthropic
connectors directory (it excludes AI media generation otherwise) and the ChatGPT directory
submission. The registry publish is done.

### Phase 4 — media made elsewhere

Status, 2026-11-10: built and in review on `feat/mcp-outside-media` (server 1.2.0, plugin
1.1.0); not merged. Proven before the PR by the unit suites and on a throwaway local stack, both
the upload protocol against real Storage and the tools end to end (runbook, "Media made
elsewhere"). Left after the merge: the production check the runbook names (a private post from
Claude Code, repeated, read, deleted) and the registry publish of 1.2.0.

The owner asked on 2026-11-10 whether an agent can post media made elsewhere, and then to plan
and add it. Until then `publish_post` took a creation only and `upload_input` staged run inputs
only. No migration, no new route, no mobile change.

Decisions:

1. **One publish tool.** `publish_post` takes exactly one of `generation_id` or `uploads`: 1 to
   `MAX_POST_MEDIA_ITEMS` (5) items `{ storage_path }`, each a file staged with `upload_input`. One
   tool keeps the audit rows under `tool = 'publish_post'`, so the daily cap, the moderation list
   and the partial index apply unchanged. An upload publish records `PUBLISHED_PUBLIC` or
   `PUBLISHED_PRIVATE` with `post_id` set and `generation_id` null.
2. **With uploads**, `title` and `made_with` are required: 1 to 5 `{ tool, model? }`, free text,
   refused for Magicbooklet's own name and wherever the composer's validator refuses.
   `description`, `body`, `category`, `visibility` (public by default) and `is_nsfw` pass through
   as the composer sends them; the recipe is none. `allow_remixes` is refused with `uploads`, and
   `made_with` with `generation_id`.
3. **The composer's own create** (`createOwnerPostForRoute`) makes the post, from a form built in
   `src/lib/agent-upload-publish-request.ts`, so the composer's rules, `POST_MUTATION_RATE_LIMIT`,
   the ownership check of every path, the consumption of each staged file and the media
   processing apply. Before it, the agent's cap for a public post, as for a creation. Refusals map
   to stable codes with the service's message and no link.
4. **Retry safety.** The post's id is derived from the creator and the ordered staged paths. A
   repeat reads it first and answers the existing post; a differing `visibility` changes it.
5. **`request_upload`** for a file an agent with a shell can send (Claude Code, Codex, Cursor): it
   counts against `AGENT_UPLOAD_INPUT_RATE_LIMIT`, applies the URL caps, calls the web's sign
   step, and answers the signed URL, the method, the web's three headers and the exact curl line.
6. **`upload_input` takes `upload_id`** as a third source: it finalizes the upload for the caller
   and applies the signature rule to the stored object's first bytes, removing a file that fails.
7. **Words.** The tools say a staged file feeds a run or becomes a post; `publish_post` explains
   both sources; the answer says to keep the `post_id`, since `list_creations` does not list such
   a post. `get_post` and `delete_post` work for a post with no creation.
8. **Consent** names it: "Your creations, or pictures and videos the agent brings from elsewhere".
9. **Setup page and plugin**: the capability, without overclaiming for a client with no shell; a
   third skill, `post-outside-media`.
10. **Version**: `MCP_SERVER_VERSION` and `server.json` at 1.2.0 together.
11. **Moderation**: `list --source agent` gains a `source` column, `creation` or `upload`.
12. **Docs**: the runbook, this section, and AGENTS.md's "Agent access (MCP)".

As built, where the code decided more than the decisions said:

- The existing post's visibility change (4) could not use the creation path's republish, which
  needs a creation behind the post. It goes through the composer's save
  (`updateOwnerPostForRoute` with the visibility alone), under the same two limits.
- `publish_post` takes only a file that went through `upload_input` and is still unused (it reads
  each path's reservation). Without that, `request_upload`, the curl line and a publish would
  have skipped the signature rule of (6). A path that is not the caller's is still left to the
  composer service's ownership rule.
- Made with is sent without the composer's `createTool` and `createModel`: a known name is filed
  under the catalog's spelling, any other stays on the post, and an agent never adds a catalog
  row (nor meets the catalog's ten tools and thirty models a day).
- An unchanged repeat of an upload publish still names its post in the audit row (a creation's
  names none): only an agent makes a post under a derived id, and the call that made it may have
  lost its row to the timeout that caused the repeat. It records `ALREADY_PUBLISHED`, which the
  cap does not count.
- The staging quota, found on the local stack: the sign step reserves 250 MB per signed upload
  against 1 GB an account, so four uploads can be open at once, and a refused or abandoned one
  keeps its place until the daily reclaim. So `upload_input` answers an upload nothing was sent
  to yet `NOT_READY` without closing it (finalize would), a fifth open upload answers
  `UPLOAD_BYTES_LIMIT` by name, and the tool and the skill say to send one file at a time. Not
  changed: the reservation size and the reclaim's schedule, which are the web's.
- `MCP_TOOLS` lives in `mcp-server-service.ts`, not the client directory; the manifests test
  reads it there.

Not in phase 4: audio posts (the composer has none), a recipe on an upload post, editing an
upload post's text or media through an agent, listing upload posts (`list_creations` lists
creations; a `list_posts` tool would be its own change).

## Client setup (what the docs page will say)

| Client | How a creator connects | Client we register |
|---|---|---|
| Claude.ai, Claude Desktop | Customize → Connectors → Add custom connector → URL `https://magicbooklet.com/api/mcp`, client id under Advanced settings, no secret | public, redirect `https://claude.ai/api/mcp/auth_callback` |
| Claude Code | `claude mcp add --transport http --scope user --client-id <id> --callback-port 8976 magicbooklet https://magicbooklet.com/api/mcp`, then `/mcp`; or the plugin, not both | public, redirect `http://localhost:8976/callback` |
| ChatGPT | Plugins → + → Add custom MCP server with the URL and, under OAuth, the client id | public (the page shows no secret), redirect per connector from its management page |
| Codex | `codex mcp add magicbooklet --url https://magicbooklet.com/api/mcp --oauth-client-id <id>`, `callback_port = 8977` in `config.toml`, then `codex mcp login magicbooklet` | public, redirect `http://127.0.0.1:8977/callback/PPpoTd8EYBlz` (and its `localhost` spare) |
| Cursor | `auth.CLIENT_ID` on the server's entry in `.cursor/mcp.json` | public, redirects `http://localhost:8787/callback` and `https://www.cursor.com/agents/mcp/oauth/callback` |

The page reads every value from `src/lib/mcp-client-directory.ts` (2026-11-10, phase 3).

Any client can also use a static `Authorization` header, but we issue no long-lived keys in v1.

## Risks

- **Supabase OAuth server is beta.** API shape may move; no audience binding (mitigated by the
  `client_id` rules); loopback and dynamic registration behaviour unverified (phase 0).
- **Consent lives on the production Site URL.** Preview deployments cannot run the OAuth flow;
  it is tested on the local stack and then in production with a real client.
- **Spend at agent speed.** Consent, the existing per-user limits, `destructiveHint`, the kill
  switch and revocation; the audit table shows who spent what through which client.
- **Feed quality.** The agent daily cap and the audit filter; the moderation queue is unchanged.
- **Distribution.** Anthropic's directory excludes media generation; the custom connector, the
  CLI command and our own plugin marketplace need no review.
- **Review cost.** Phase 1 is well over 300 lines and touches admission: `max` review, single
  reviewer, each finding answered before merge.

## Not in v1

Buying credits, social actions (follow, comment, like), templates and workflows, the
marketplace, long-lived API keys, scope-based permissions, a custom auth domain (a paid add-on;
owner, 2026-11-01: nothing that needs extra money).
