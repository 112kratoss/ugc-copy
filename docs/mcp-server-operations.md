# MCP server operations

The agents' MCP server lives at `https://magicbooklet.com/api/mcp`. An agent in Claude.ai, Claude
Desktop, Claude Code, ChatGPT, Codex or Cursor connects to it, signs a creator in through
Supabase Auth's OAuth 2.1 server, and then creates media with that creator's credits
(phase 1: `list_models`, `get_model`, `quote_generation`, `create_media`, `get_generation`,
`list_creations`, `enhance_prompt`). The plan, the decisions behind it and the later phases are
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
when it failed: `COST_CHANGED`, `INSUFFICIENT_CREDITS`, `RATE_LIMITED`, …), `costCredits` when
the answer carried a cost, and `elapsedMs`. Prompts and results are never logged. A refused
request logs `mcp_request_refused` with the status and the reason (`no_token`, `token`,
`identity`, `AGENT_TOKEN_REQUIRED`). In the Vercel logs, filter on `msg:mcp_tool_call` and
group by `clientId` to see which client spends what; `outcome:threw` is a bug to read with its
`errorName` and `errorMessage`.

Rate limits are the creator's own: the generation start's 30 per 10 minutes, the quote's 240,
the library read's 400 (polls in `get_generation` count once per call), prompt enhancement's
60. An agent that hits them is answered `RATE_LIMITED` with `retry_after_seconds`.

## Revoking a client, or one creator's grant

- One creator: phase 2 adds Connected apps to the profile editor (`listGrants`,
  `revokeGrant({ clientId })`). Until then, the creator's grants are revoked in the dashboard
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
