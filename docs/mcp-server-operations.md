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

The proxy refuses a `client_id`-bearing token on every other `/api` route
(403 `AGENT_TOKEN_NOT_ALLOWED`), so a leaked agent token can do only what the consent screen
said, on the one route built for it.

## Enabling the OAuth server (production dashboard)

Supabase Auth's OAuth server is off by default and is enabled per project in the dashboard,
not from this repository.

1. Authentication → OAuth Server (beta): enable it.
2. Set the authorization path to `/oauth/consent` (the consent page this app serves; the
   dashboard composes it with the project's Site URL, which is `https://magicbooklet.com`).
3. Leave dynamic client registration off unless the phase 0 spike found a client that needs
   it (Codex, Cursor). *[Placeholder: the spike's finding on dynamic registration.]*
4. Confirm with the anon key that `GET https://<project-ref>.supabase.co/auth/v1/.well-known/oauth-authorization-server`
   now answers metadata rather than `feature_disabled`, and that `GET /auth/v1/health` reports
   an Auth version with the OAuth server API (the consent page's `getAuthorizationDetails`,
   `approveAuthorization` and `denyAuthorization` calls need it).

The local stack enables the same block in `supabase/config.toml` (`[auth.oauth_server]`,
`enabled = true`, `authorization_url_path = "/oauth/consent"`); the spike's worktree carries
that change until it merges.

## Registering a client (an "OAuth App")

Each agent product is one OAuth client: Authentication → OAuth Server → Apps → New. The client
id is public; a confidential client's secret is shown once, so put it straight into the
connector form it is for and keep no copy in this repository or in chat (the AGENTS.md rule on
secrets applies).

| Client | Type | Redirect URI(s) | Where the creator enters it |
|---|---|---|---|
| Claude.ai and Claude Desktop (custom connector) | confidential | `https://claude.ai/api/mcp/auth_callback` | Settings → Connectors → Add custom connector → URL `https://magicbooklet.com/api/mcp`, client id and secret under Advanced |
| Claude Code | public | `http://localhost:<port>/callback` with the port we document *[placeholder: the spike's port]* | `claude mcp add --transport http --client-id <id> --callback-port <port> magicbooklet https://magicbooklet.com/api/mcp`, then `/mcp` |
| ChatGPT (developer-mode connector) | confidential | *[placeholder: the redirect the spike confirms]* | Settings → Connectors → Create, with the URL, client id and secret |
| Codex | *[placeholder: public client or dynamic registration, per the spike]* | *[placeholder]* | `codex mcp add magicbooklet --url https://magicbooklet.com/api/mcp`, then `codex mcp login magicbooklet` |
| Cursor | *[placeholder: dynamic registration, per the spike]* | *[placeholder]* | deeplink or `.cursor/mcp.json` |

A redirect URI must match exactly, scheme, host, port and path. Supabase ignores the `resource`
parameter clients send (it binds a token to no resource), which is why the route requires the
`client_id` claim instead. The consent screen shows a fixed description of what an agent may do
(there are no scopes).

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

- One creator: phase 2 adds Connected apps to the profile editor (`listGrants`, `revokeGrant`).
  Until then, the creator's grants are revoked in the dashboard under Authentication → Users →
  the user → OAuth grants, or by signing the user out everywhere (which revokes every session,
  the agent's included).
- One client for everyone: Authentication → OAuth Server → Apps → the app → delete or disable
  it. Tokens already issued keep working until they expire (one hour); the refresh fails after
  that.
- Everyone at once: the kill switch above.

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
