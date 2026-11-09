# MCP server operations

The agents' MCP server lives at `https://magicbooklet.com/api/mcp`. An agent in Claude.ai, Claude
Desktop, Claude Code, ChatGPT, Codex or Cursor connects to it, signs a creator in through
Supabase Auth's OAuth 2.1 server, and then creates media with that creator's credits and
publishes it as that creator (phase 1: `list_models`, `get_model`, `quote_generation`,
`create_media`, `get_generation`, `list_creations`, `enhance_prompt`; phase 2: `upload_input`,
`publish_post`, `get_post`, `delete_post`, and the `agent_tool_calls` audit table every call
writes). The plan, the decisions behind it and the later phases are
`docs/plans/agent-mcp-server-plan-2026-11-09.md`; this runbook is what an operator does.

Code: `src/app/api/mcp/route.ts` → `src/lib/mcp-route-adapter-service.ts` (kill switch,
admission, transport) → `src/lib/mcp-server-service.ts` (the tools) → the services the web
calls. The protected-resource metadata every client reads first is served at
`/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/api/mcp`
(`src/lib/oauth-protected-resource-metadata.ts`). What makes a token an agent's token is
`src/lib/agent-token.ts`.

## How a connection works

1. The agent POSTs to `/api/mcp` with no token and is answered 401 with
   `WWW-Authenticate: Bearer resource_metadata="https://magicbooklet.com/.well-known/oauth-protected-resource/api/mcp", error="invalid_token"`.
2. It reads that document, which names the authorization server:
   `https://<project-ref>.supabase.co/auth/v1`, Supabase Auth's OAuth server.
3. It sends the person's browser to Supabase's authorize endpoint (PKCE), which sends them to
   our consent page, `/oauth/consent`. Signed out, the page goes through `/login` first; a guest
   session is refused (registered accounts only); an account approves or denies.
4. Supabase redirects to the client's redirect URI with a code; the agent exchanges it for an
   ordinary Supabase JWT (one hour, with a refresh token) that carries the OAuth client's id in
   its `client_id` claim.
5. Every tool call carries that token. The route verifies it as the proxy verifies any token
   (signature against the project's JWKS, then the lifecycle round trip: session still valid,
   account not banned, not merged, not deleting) and additionally requires the `client_id`
   claim. Every service, RLS policy and rate limit then applies to the agent as it applies to
   the creator in the browser.

On this app's own surfaces an agent token drives no API route but `/api/mcp`, and no page or
cookie session: the proxy refuses a `client_id`-bearing token on every other `/api` route (403
`AGENT_TOKEN_NOT_ALLOWED`), the server-rendered pages refuse it as a session
(`getServerAuthState`), and the media routes, which take a browser's cookie session when no
bearer token is sent, refuse it there too (`media-route-shared.ts`). What the claim does not do is
bind the token to this app: against the Supabase project directly (PostgREST, Storage, Auth) an
agent token is the creator's session under RLS, like any user token, so whoever holds a leaked one
can read and change what that account may until the grant is revoked (which deletes the token's
session) or the hour runs out. Revocation and expiry are the remedy; see "Revoking a client".

## Enabling the OAuth server (production dashboard)

Supabase Auth's OAuth server is off by default and is enabled per project in the dashboard,
not from this repository.

1. Authentication → OAuth Server (beta): enable it.
2. Set the authorization path to `/oauth/consent` (the consent page this app serves; the
   dashboard composes it with the project's Site URL, which is `https://magicbooklet.com`).
3. Leave dynamic client registration **off** (the spike's recommendation,
   `docs/research/mcp-oauth-spike-2026-11-09.md`): registration works on this GoTrue, but every
   zero-config `claude mcp add` or Codex install would add a client row and the consent screen
   would name whatever the client registered. Off, the client list is ours: one public client per
   surface, below. Phase 3 reconsiders.
4. Verify discovery and the no-key endpoints (Production switch-on, below): the three discovery
   URLs answer metadata rather than `feature_disabled`, and `/auth/v1/oauth/authorize` and
   `/auth/v1/oauth/token` answer without an `apikey` header through production Kong (OAuth
   clients cannot send one). `GET /auth/v1/health` names the Auth version; the spike ran on GoTrue
   v2.186.0, which production also runs.

The local stack has the same block on in `supabase/config.toml` (`[auth.oauth_server]`,
`enabled = true`, `authorization_url_path = "/oauth/consent"`, registration off); nothing pushes
that file to production, whose switch is the dashboard alone. The switch alone does not make the
flow runnable against the stack as it is, because its `site_url` stays `https://magicbooklet.com`
on purpose: a local authorize would send the browser to production's consent page. To exercise
`/oauth/consent`, an agent token and revocation locally, run the stack the spike did
(`docs/research/mcp-oauth-spike-2026-11-09.md`, "Stack config changes"): a scratchpad copy of
`supabase/` with a `project_id` of its own, its ports moved to 563xx, `site_url` and
`additional_redirect_urls` set to the dev server's origin (the spike used
`http://localhost:3300`, with `http://localhost:3300/**` and `http://127.0.0.1:3300/**`),
`[auth.oauth_server] enabled = true`, and an ES256 signing key (`supabase gen signing-key
--algorithm ES256` into the copy, named by `signing_keys_path`) so tokens verify like
production's; without the key the stack signs HS256 and `openid` cannot issue an ID token. The
dev server is then started from the worktree with that stack's URL and anon key in its env, as
the E2E server is given its env, and no `.env*` file is written.

## Registering a client (an "OAuth App")

Each agent product is one **public** OAuth client (`token_endpoint_auth_method: none`, with a
`client_uri` so the consent screen can name and link it), registered with the ops script under
the service role:

```bash
npm run ops:oauth-clients -- list
```

```bash
npm run ops:oauth-clients -- create --name "Claude Code" --client-uri https://claude.com/claude-code --redirect-uri http://localhost:8976/callback --apply
```

Without `--apply` the script only shows what it would register; it prints client ids (public)
and never a secret (a `--confidential` client's secret goes to the clipboard, for the connector
form it is for, and nowhere else: the AGENTS.md rule on secrets). It registers on whichever
project `.env.local` points at and names that project's origin in every output: the file is
hand-toggled between the local stack and production (`docs/local-development.md`), so check that
the **production** block is the active one before `--apply`, or the client id you paste into a
connector form is one production has never heard of. The dashboard's Authentication → OAuth
Server → Apps page does the same by hand.

| Client | Redirect URI(s) to register | How the creator connects |
|---|---|---|
| Claude.ai, Claude Desktop, Claude mobile | `https://claude.ai/api/mcp/auth_callback` (exactly this) | Settings → Connectors → Add custom connector → URL `https://magicbooklet.com/api/mcp`; under Advanced ("Use your own OAuth client") the client id, no secret |
| Claude Code | `http://localhost:8976/callback` (our documented port; the URI must match exactly, so the port is fixed) | `claude mcp add --transport http --client-id <id> --callback-port 8976 magicbooklet https://magicbooklet.com/api/mcp`, then `/mcp` (or `claude mcp login magicbooklet`, which needs a terminal) |
| ChatGPT (connectors, Apps SDK) | the per-connector `https://chatgpt.com/connector/oauth/{callback_id}` shown on the connector's management page: create the connector first, then register its URI (GoTrue sends no RFC 9207 `iss`, so ChatGPT's shared redirect does not apply) | Settings → Connectors → Create (developer mode) with the URL and the client id |
| Codex CLI | `http://127.0.0.1:8977/callback/<callback_id>` exactly as `codex mcp add` prints it with `mcp_oauth_callback_port = 8977` pinned, or a pinned `mcp_servers.magicbooklet.oauth.callback_url` such as `http://127.0.0.1:8977/callback/magicbooklet` | `codex mcp add magicbooklet --url https://magicbooklet.com/api/mcp --oauth-client-id <id>`, then `codex mcp login magicbooklet` |
| Cursor | `http://localhost:8787/callback` (desktop) and `https://www.cursor.com/agents/mcp/oauth/callback` (web and Cursor Agents) | `auth: { CLIENT_ID: "<id>" }` on the server entry in `.cursor/mcp.json`, or the deeplink |

A redirect URI must match exactly: scheme, host, port and path (`127.0.0.1` is not `localhost`;
no port-agnostic loopback). Supabase accepts and ignores the `resource` parameter clients send
(it binds a token to no resource), which is why the route requires the `client_id` claim instead.
The token's `scope` is only `openid profile email phone` class and is never shown as permissions;
the consent screen shows the fixed description of what an agent may do.

## Publishing by agents

`publish_post` makes a post of one of the creator's own succeeded creations through the same
publish service the web's Publish uses (`showcase-publish-service.ts`), so the post is the one the
web would have made: live by default (`visibility: public`), or `private` to keep it on the
creator's profile. With `allow_remixes` (the default) it carries the creation's free recipe, the
exact prompt and the saved inputs the creation may share, as the creator page's one-click Publish
does; without it the media goes alone. The rules the owner set (2026-11-09):

- **Two limits.** Every agent publish passes the web's publish limit (`SHOWCASE_PUBLISH_RATE_LIMIT`,
  20 per 10 minutes per account, which counts attempts as the route does) and, where it makes a
  post public, the agent cap (`AGENT_PUBLISH_RATE_LIMIT` in `backend-rate-limit.ts`, 10 public
  posts per account per UTC day). The cap counts publications, not attempts: the tool counts the
  day's rows recorded `PUBLISHED_PUBLIC` in `agent_tool_calls` before it publishes, so a publish
  the service refuses (a missing handle, a safety refusal, a short recipe title) spends nothing,
  and a private post is not counted. The row is written behind the answer, so two publishes a
  moment apart may both pass: the cap is a guard against a loop, not an exact quota. The tool
  answers `RATE_LIMITED` with `retry_after_seconds` and `reset_at` (the next midnight UTC).
- **What an agent may publish.** The creator's own succeeded creation. One an operator removed
  (`generations.moderation_removed_at`) is answered `NOT_FOUND`, and the publish service itself
  now refuses it on every route, so a removal is never republished; one the creator archived is
  answered `NOT_READY`; another creator's answers `NOT_FOUND` too, disclosing nothing. Without a
  `title` the tool sends the title the web's Publish starts from (the creation's own, else one
  suggested from its prompt), so an agent's post is the web's post.
- **A republish changes nothing.** Publishing a creation that already has a post returns that post
  with `already_published: true` and its real `state` (live, private, archived, hidden, removed);
  only an explicit `visibility` that differs changes the post's visibility (through the service's
  own visibility-only path, which keeps the post's text and recipe). The post's text is never
  rewritten by a second publish, and the audit row of an unchanged republish names no post, so
  the moderation list never counts a post the creator published by hand as an agent's.
- **The moderation queue is the same.** An agent's post is a post: reports, the console and the
  CLI treat it as any other. `npm run ops:moderation -- list --source agent` lists the posts agents
  published (newest first, each with its state, from the audit table) and narrows the open post
  reports to them, so an operator can review what agents put on the feed whether or not anyone
  reported it; a take-down is `take-down-post` on its report, as for any post.
- **Uploads.** `upload_input` stages a file the person supplies through the web's own staging path
  (sign, upload as a Blob, finalize, a signed read URL), so the byte reservations and the reclaim
  sweep apply as to any upload. It is counted before any byte is fetched
  (`AGENT_UPLOAD_INPUT_RATE_LIMIT`, 30 per 10 minutes per account), so a loop of large or failing
  downloads is stopped. By URL it fetches public https hosts only: the host is resolved and every
  address must be public unicast (no loopback, private, link-local, carrier-grade NAT, multicast
  or reserved range, IPv6 embeddings included), the connection is pinned to the checked addresses,
  one redirect on the same host is followed and checked again, the type is read from
  `Content-Type` against the storage MIME policy and the first bytes (a picture must carry a
  picture's signature; a clip or a track is refused only when its bytes say another kind), and
  the body is capped at 25 MB for a picture and 50 MB for a clip or a track
  (`AGENT_URL_FETCH_MAX_BYTES_BY_KIND`, below the sign step's own caps, because the whole file is
  buffered in the function and the fetch, store, finalize and read URL must fit in its 60
  seconds). By base64 it takes at most 3 MB decoded: Vercel caps a request body at 4.5 MB, and the
  encoding and the JSON-RPC envelope must fit under it.
- **The inline preview.** `get_generation` carries a finished picture inline as an `image` block
  only when the caller passes `include_preview: true`, and only when its preview is under 512 KB,
  so polls stay small.

### The audit table

Every tool call writes one row of `public.agent_tool_calls` behind its answer
(`src/lib/agent-tool-calls.ts`, migration `20261109183611_agent_tool_calls.sql`): `user_id`,
`client_id` (the OAuth client), `tool`, `ok`, `code` (the tool's error code when it failed; for a
successful `publish_post`, which answer it was: `PUBLISHED_PUBLIC`, `PUBLISHED_PRIVATE`,
`MADE_PRIVATE` or `ALREADY_PUBLISHED`), `generation_id` and `post_id` where the call was about
one (an unchanged republish names no post), `cost_credits` where the answer charged the creator,
`created_at`. Prompts and results are never written. The owner may read their own rows; the
service role appends; nothing updates or deletes a row (an account's rows go with the account).
The write never holds or fails an answer: a failed write logs `mcp_tool_call_record_failed`.

Retention is a follow-up: every call writes a row, each `get_generation` poll included, and the
service role has no `DELETE`, so the table only grows until a later migration adds a pruning
function (keep the publish and delete rows, prune the read rows after some months). Until then
`operational-table-growth.ts` carries a budget for it (warning at 200k rows), and the moderation
listing's partial index keeps its read cheap at any size. Queries an operator reaches for, in the
dashboard's SQL editor:

```sql
-- What an agent client did for one creator today, newest first.
select created_at, tool, ok, code, generation_id, post_id, cost_credits
from public.agent_tool_calls
where user_id = '<user-id>' and created_at > now() - interval '1 day'
order by created_at desc;

-- The posts agents published this week, with each post's state.
select c.created_at, c.client_id, c.user_id, c.post_id, p.visibility, p.review_status, p.title
from public.agent_tool_calls c
left join public.posts p on p.id = c.post_id
where c.tool = 'publish_post' and c.ok and c.post_id is not null and c.created_at > now() - interval '7 days'
order by c.created_at desc;

-- Credits spent through agents, by client, this month.
select client_id, count(*) as calls, sum(cost_credits) as credits
from public.agent_tool_calls
where cost_credits is not null and created_at > date_trunc('month', now())
group by client_id order by credits desc;
```

## Connected apps

A creator sees the agents they approved under **Connected apps** on `/profile/edit` (one row per
OAuth client, named as the client registered itself, with the day it was approved) and ends one's
access with **Disconnect**, which asks first. The section reads and revokes through Supabase
Auth's grants API from the web session (`supabase.auth.oauth.listGrants()`,
`revokeGrant({ clientId })`; `src/lib/connected-apps.ts`, `src/app/profile/edit/ConnectedApps.tsx`),
so no route of this app is involved. Where the project's OAuth server is off (the local stack as
shipped, a preview project) the grants API answers `feature_disabled`, which the section reads as
no apps connected rather than as a failure. Revoking deletes the client's sessions: the agent's next
call fails the route's lifecycle check and is answered 401 with the challenge, its refresh fails,
and connecting again goes through the consent screen afresh.

## The kill switch

`MCP_SERVER_DISABLED=1` in the Vercel Production environment, followed by a configuration-only
redeployment (`docs/production-deployment-runbook.md`, "Configuration-only redeployment"),
answers every call to `/api/mcp` with 503 and `Retry-After: 300` before any token is read.
Nothing else changes: the web and the app keep working, tokens stay valid, and the consent
page keeps approving. Remove the variable and redeploy to switch the server back on. Use it
when an agent is spending at a rate the rate limits do not stop, or when the OAuth server
misbehaves; revoke the client (below) when the problem is one client.

## Reading the logs

Every tool call writes one structured line, `mcp_tool_call`, with `clientId` (the OAuth
client), `userId`, `tool`, `outcome` (`ok`, `error` or `threw`), `code` (the tool's error code
when it failed: `COST_CHANGED`, `INSUFFICIENT_CREDITS`, `RATE_LIMITED`, `NOT_OWNER`,
`NOT_READY`, …), `costCredits` when the answer carried a cost, `generationId` and `postId` where
the call was about one, and `elapsedMs`. Prompts and results are never logged. A refused
request logs `mcp_request_refused` with the status and the reason (`no_token`, `token`,
`identity`, `AGENT_TOKEN_REQUIRED`). In the Vercel logs, filter on `msg:mcp_tool_call` and
group by `clientId` to see which client spends what; `outcome:threw` is a bug to read with its
`errorName` and `errorMessage`. The same facts are queryable in the audit table (Publishing by
agents → The audit table), which outlives the log retention.

Rate limits are the creator's own: the generation start's 30 per 10 minutes, the quote's 240,
the library read's 400 (polls in `get_generation` and `get_post` count once per call), prompt
enhancement's 60, the publish's 20 plus the agent cap of 10 public posts per UTC day, the post
mutation's 60 for `delete_post`, and `upload_input`'s own 30 per 10 minutes before the upload
sign, finalize and read-url limits. An agent that hits them is answered `RATE_LIMITED` with
`retry_after_seconds`.

## Revoking a client, or one creator's grant

- One creator: the creator does it themselves under Connected apps on `/profile/edit` (above:
  `listGrants`, `revokeGrant({ clientId })`). An operator does the same for them in the dashboard
  under Authentication → Users → the user, or by signing the user out everywhere (which revokes
  every session, the agent's included). A revoked grant deletes the client's sessions: the agent's
  access token still verifies by signature until it expires, but the route's lifecycle round trip
  answers `session_valid: false` and the next call is 401 with the challenge, and the refresh
  fails. That is why the route never trusts the signature alone.
- One client for everyone: Authentication → OAuth Server → Apps → the app → delete or disable
  it. Tokens already issued keep working until they expire (one hour); the refresh fails after
  that.
- Everyone at once: the kill switch above.

## Production switch-on checks

Before the first client is announced, with the OAuth server enabled on the production project
(`<ref>` is the project reference), each of these must hold; the spike proved them on a local
stack only, where the path-insertion forms answered 404 through local Kong:

1. Discovery, all three forms answer the authorization server's metadata with
   `issuer: https://<ref>.supabase.co/auth/v1`:
   `https://<ref>.supabase.co/.well-known/oauth-authorization-server/auth/v1` (RFC 8414
   path insertion, which Claude Code tries first),
   `https://<ref>.supabase.co/.well-known/openid-configuration/auth/v1`, and
   `https://<ref>.supabase.co/auth/v1/.well-known/openid-configuration` (where Claude Code
   succeeded on the local stack). `https://<ref>.supabase.co/auth/v1/.well-known/oauth-authorization-server`
   is the fourth, Supabase's own.
2. `GET /auth/v1/oauth/authorize?...` and `POST /auth/v1/oauth/token` answer **without an
   `apikey` header** through production Kong, since OAuth clients cannot send one (an authorize
   with a wrong `redirect_uri` answers 400 `invalid redirect_uri`, which proves the endpoint is
   open without starting a flow).
3. The `WWW-Authenticate` challenge reaches Claude Code through Vercel: `claude mcp add` with
   the Claude Code client and `--callback-port 8976`, then `/mcp` opens the browser on
   `/oauth/consent`, Allow lands on Claude Code's own callback page, and `claude mcp get
   magicbooklet` reports Connected. The route's 401 carries the challenge; the proxy's own 401
   does not, which is why `/api/mcp` owns its admission.
4. `list_models` through Claude Code answers the production catalog's revision, and a
   `get_generation` with `wait_seconds` 45 on a running creation answers rather than timing
   out: the wait, the admission round trips and the final read must all fit under the route's
   60 seconds and the client's own request timeout (the tools suggest 30 for that reason).

## Verifying a deployment

After a release that touches the server:

```bash
curl -sS https://magicbooklet.com/.well-known/oauth-protected-resource/api/mcp
```

answers the metadata with `resource` `https://magicbooklet.com/api/mcp` and the project's
`/auth/v1` as its authorization server, and

```bash
curl -sS -o /dev/null -D - -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' https://magicbooklet.com/api/mcp
```

answers 401 with the `WWW-Authenticate` challenge above (or 503 while the kill switch is set).
Then connect once from Claude Code against production and call `list_models`.
