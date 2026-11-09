# MCP OAuth spike — Supabase Auth as the authorization server

Status: done, 2026-11-09. Phase 0 of
[`../plans/agent-mcp-server-plan-2026-11-09.md`](../plans/agent-mcp-server-plan-2026-11-09.md), run end to end on a
throwaway local stack (project `magicbooklet-mcp-spike`, ports 563xx, torn down afterwards). Nothing was merged or
pushed; no production project was touched. The throwaway code lives in the worktree
`.claude/worktrees/mcp-spike` (branch `spike/mcp-oauth`, uncommitted): `src/app/api/mcp/route.ts`,
`src/app/.well-known/oauth-protected-resource/{,api/mcp/}route.ts`, `src/app/oauth/consent/page.tsx`, and the
secret-free driver scripts under `scripts/spike-mcp-oauth/` (seed, PKCE flow, callback listener, anonymous check,
the `:3300` dev-server wrapper, the pty wrapper for `claude mcp login`, the stack scripts).

## Verdict: GO

Supabase Auth's OAuth 2.1 server (GoTrue v2.186.0, the image both local stacks and production run) authorizes MCP
clients for Magicbooklet. Every step of the plan's authorization flow worked: discovery, authorize with PKCE,
the app's consent page, code exchange, an ES256 user token carrying `client_id`, the MCP route accepting it,
RLS reads under it, refresh, re-consent auto-approval, grant listing and revocation, and both a pre-registered
and a dynamically registered Claude Code client. The conditions the rest of this note establishes:

1. **The token binds to nothing.** `resource` is accepted and ignored, `aud` is always `authenticated`, no custom
   scope exists. The route must require the `client_id` claim and the proxy must refuse `client_id` tokens on
   every other `/api` route, exactly as the plan says. Authorization is per tool, by the user.
2. **GoTrue lets a guest consent.** An anonymous session can read and approve an authorization and gets a code.
   The consent page refuses `is_anonymous` sessions and the route refuses `is_anonymous` tokens (the existing
   admission's `REGISTRATION_REQUIRED` already does the second half).
3. **Revocation needs the lifecycle check, not just the signature.** `revokeGrant` deletes the client's sessions;
   `getClaims()` keeps accepting the access token until it expires, but `current_identity_admission()` answers
   `session_valid: false`, RLS returns nothing, and the refresh fails. The route must run
   `evaluateUserFacingRouteIdentity` (as planned), never a signature-only check like the spike's.
4. **Redirect URIs match exactly** (scheme, host, port, path; `127.0.0.1` ≠ `localhost`; no RFC 8252 port-agnostic
   loopback). A pre-registered client therefore works only for clients with a fixed callback: Claude Code with
   `--callback-port`, Cursor desktop, Claude.ai/Desktop, ChatGPT, Codex with a pinned port. Zero-config Claude
   Code (random port) and Codex's default ephemeral port need dynamic registration, which works on this GoTrue.
5. **Discovery.** The local stack serves the metadata at `/auth/v1/.well-known/oauth-authorization-server` and
   `/auth/v1/.well-known/openid-configuration`, not at the RFC 8414 path-insertion URL
   `/.well-known/oauth-authorization-server/auth/v1` (404 through local Kong). Claude Code tried the two
   path-insertion forms, got 404s, and succeeded on the OIDC path-appending form. Supabase's docs give the
   path-insertion URL as the hosted project's discovery endpoint, so production should answer all three; phase 1
   verifies `https://<ref>.supabase.co/.well-known/oauth-authorization-server/auth/v1` once the server is on
   (today it answers `feature_disabled`, which already proves the route exists).
6. **No `apikey` header** was needed for `/oauth/authorize`, `/oauth/token`, `/oauth/userinfo` or the metadata on
   the local Kong. OAuth clients cannot send one, so phase 1 confirms the same on production Kong.

Fallback (a self-made authorization server) is not needed.

## What ran

| Piece | Version / fact |
|---|---|
| Supabase CLI | 2.75.0 (`npx --yes supabase@2.75.0`) passed `[auth.oauth_server]` through: the container got `GOTRUE_OAUTH_SERVER_ENABLED=true`, `…_AUTHORIZATION_PATH=/oauth/consent`, `…_ALLOW_DYNAMIC_REGISTRATION=false|true`. 2.109.1 was not needed. `start -x studio,inbucket,logflare,vector,edge-runtime` (2.75.0 names the mail container `mailpit`; `inbucket` is ignored with a warning). `db reset --local` replayed all 353 migrations. |
| GoTrue | v2.186.0 (`/auth/v1/health`) |
| Signing | ES256, to match production: `supabase gen signing-key --algorithm ES256` written to `supabase/signing_keys.json` in the copy with `signing_keys_path = "./signing_keys.json"`; the JWKS served one EC key; tokens came out `alg: ES256` with a `kid`. Without it the stack signs HS256 and `openid` cannot issue an ID token. |
| Stack config changes | `project_id = "magicbooklet-mcp-spike"`, ports `543xx → 563xx`, `site_url = "http://localhost:3300"`, `http://localhost:3300/**` and `http://127.0.0.1:3300/**` added to `additional_redirect_urls`, `[auth.oauth_server] enabled = true`, `allow_dynamic_registration` false then true. |
| Web | next 16.3.3, `next dev --webpack --port 3300` from the worktree with the E2E env shape (every `.env.example` name unset, `PLACEHOLDER_ENV`, Supabase pointed at the stack from the status env file, `tests/e2e/support/no-env-files.cjs` preloaded); no `.env*` file written. Launch entry `web-mcp-spike` (removed). |
| Packages added to the worktree | `mcp-handler@2.3.1`, `@modelcontextprotocol/server@2.4.0` (both installed cleanly in 4 s; peer `next >=13`, `@modelcontextprotocol/server ^2`); `zod@4.3.6` already present. `@supabase/supabase-js@2.108.2` (`auth-js` 2.108.2) has `auth.oauth.*` and `auth.admin.oauth.*`. |
| Claude Code | 2.1.302 at `/Users/athuls/.local/bin/claude` |
| Node for the scripts | v22.17.0 on this Mac (the repo pins 24; irrelevant to the findings) |

Endpoints and metadata observed on the local stack (base `http://127.0.0.1:56321`):

- `GET /auth/v1/.well-known/oauth-authorization-server` → 200, `issuer: http://127.0.0.1:56321/auth/v1`;
  `GET /.well-known/oauth-authorization-server` → 200 (same document); `GET /.well-known/oauth-authorization-server/auth/v1` → 404;
  `GET /auth/v1/.well-known/openid-configuration` → 200.
- Metadata: `scopes_supported: [openid, profile, email, phone]`, `response_types_supported: [code]`,
  `grant_types_supported: [authorization_code, refresh_token]`, `code_challenge_methods_supported: [S256, plain]`,
  `token_endpoint_auth_methods_supported: [client_secret_basic, client_secret_post, none]`,
  `id_token_signing_alg_values_supported: [RS256, HS256, ES256]`; `registration_endpoint:
  http://127.0.0.1:56321/auth/v1/oauth/clients/register` appears only with dynamic registration on. Absent:
  `client_id_metadata_document_supported` (no CIMD), `authorization_response_iss_parameter_supported` (no RFC 9207).
- `GET /auth/v1/oauth/authorize` → 302 to `<site_url>/oauth/consent?authorization_id=<32 chars>`; an invalid
  `redirect_uri` → 400 `invalid redirect_uri` (no redirect); an unsupported scope → 302 to the client's
  `redirect_uri` with `error=invalid_request&error_description=unsupported scope: …`.
- supabase-js consent calls seen in the logs: `GET /auth/v1/oauth/authorizations/{id}`,
  `POST /auth/v1/oauth/authorizations/{id}/consent` (`approve`/`deny`), `GET|DELETE /auth/v1/user/oauth/grants`.
- `POST /auth/v1/oauth/token` (form-encoded, public client: `grant_type, code, client_id, redirect_uri,
  code_verifier`) → `{ access_token, refresh_token, token_type: bearer, expires_in: 3600, id_token? }`, no `scope`
  field, no `user` object. A wrong verifier → 400 `invalid_grant` "PKCE verification failed".
- `GET /auth/v1/oauth/userinfo` with the bearer → `{ sub, email, email_verified }`.
- Admin: `auth.admin.oauth.createClient({ client_name, client_uri?, redirect_uris, token_endpoint_auth_method:
  'none' })` → a `public` client, `registration_type: manual`, `grant_types: [authorization_code,
  refresh_token]`, no secret returned. Auth tables: `auth.oauth_clients`, `auth.oauth_authorizations`,
  `auth.oauth_consents (user_id, client_id, scopes, granted_at, revoked_at)`, `auth.oauth_client_states`;
  `auth.sessions.oauth_client_id` records which client a session belongs to.

## Claims of an agent token

Access token from the curl client (scope `openid email`), ES256, header `{ alg: ES256, kid, typ: JWT }`:

| Claim | Value | Note |
|---|---|---|
| `iss` | `http://127.0.0.1:56321/auth/v1` | the stack's API URL + `/auth/v1`; production: `https://<ref>.supabase.co/auth/v1` |
| `sub` | the user's id | |
| `aud` | `authenticated` | never the resource, with or without `resource=` |
| `role` | `authenticated` | the admission requires it |
| `exp` / `iat` | 1 h apart | `jwt_expiry = 3600` |
| `email` | the user's email | |
| `client_id` | the OAuth client's id | **present only on OAuth-issued tokens**; an app session has none |
| `scope` | `openid email` | the scopes consented; `email` when the client sent none |
| `is_anonymous` | `false` | `true` for a guest, which GoTrue would have issued |
| `session_id` | a session id | the session `revokeGrant` deletes |
| `aal` / `amr` | `aal1` / `[{ method: oauth_provider/authorization_code }]` | the `amr` method names the OAuth grant |
| `app_metadata` / `user_metadata` | as for any user token | `provider: email`, the seeded `full_name` |

The refreshed token kept `client_id`, `scope`, `session_id`, `is_anonymous`. The ID token (only with `openid`)
has `aud` = the client id, `auth_time`, `email`, `email_verified`, `phone_number_verified`, `client_id`.

## Checks

### 1. Curl-driven flow (public client `curl spike client`, redirect `http://localhost:33419/cb`)

- Authorize URL opened in the browser pane (no `apikey`): 302 to `/oauth/consent?authorization_id=…` on the app.
- Consent page (skeleton in the worktree) showed `client.name`, `client.id`, `client.uri` (empty for this
  client), `redirect_uri`, `scope: "openid email"`, the user's email; Approve →
  `approveAuthorization(id, { skipBrowserRedirect: true })` returned `redirect_url =
  http://localhost:33419/cb?code=…&state=…`; the page navigated there and a one-shot listener captured
  `code` and `state` (and nothing else: no `iss`).
- Exchange at `/auth/v1/oauth/token` without `apikey`: 200, the claims above, `id_token` present.
- `POST /api/mcp` with the bearer: `initialize`, `tools/list`, `tools/call whoami` all 200 (mcp-handler answers
  `text/event-stream` with one `data:` line each; stateless, no session id, `tools/call` without a prior
  `initialize` on the same connection worked). `whoami` returned the verified claims.
- RLS under the agent token through PostgREST (bearer + anon `apikey`): `profiles?id=eq.<sub>` → the own row;
  `profiles?select=id&limit=5` → only the own row.
- `grant_type=refresh_token` (public client: `refresh_token` + `client_id`) → 200, new access and refresh token,
  no `id_token`.

### 2. Second authorize, same client, same user and scope

GoTrue still redirected to the consent page, and `getAuthorizationDetails` returned an `OAuthRedirect`
(`{ redirect_url }`); the page followed it without any click and the listener got a fresh code. So consent is
remembered per (user, client, scopes) and the page must handle the redirect shape, as the skeleton does.

### 3. Grants from the web session

- `supabase.auth.oauth.listGrants()` → `[{ client: { id, name }, scopes: [openid, email], granted_at }]`.
- `revokeGrant` takes **`{ clientId }`** (camelCase); `{ client_id }` fails 400 `validation_failed` "invalid
  client_id format". After it: `listGrants()` → `[]`; the web session itself stays signed in.
- Effects on the agent's tokens: the agent's `auth.sessions` row is gone; `POST /api/mcp` with the still-valid
  access token was **still accepted by the spike route** (signature-only `getClaims()`); PostgREST reads with
  it returned `[]` (the repo's `authenticated_identity_active` policy calls `current_identity_is_active()`, which
  requires `session_valid: true` from `current_identity_admission()`, and that function looks the token's
  `session_id` up in `auth.sessions`); `current_identity_admission` RPC → `{ state: active, session_valid: false,
  banned: false }`, which the proxy's admission turns into 401; refresh → 400 `refresh_token_not_found`
  "Invalid Refresh Token: Refresh Token Not Found" (not RFC 6749's `invalid_grant`, which Claude's docs ask
  for; Claude Code's documented behaviour on a failed refresh is to reconnect without the token, get the 401 and
  ask the user to sign in again).
- A later authorize for the revoked client asked for consent again (the `oauth_consents` row was reused with a
  new `granted_at`), then auto-approved on the next one.

### 4. Claude Code with the pre-registered client

- Client: `Claude Code (spike)`, `client_uri: https://claude.com/claude-code`, redirect URIs
  `http://localhost:33418/callback` (the one it used), plus `/oauth/callback` and the `127.0.0.1` form (unused).
- `claude mcp add --transport http --client-id <id> --callback-port 33418 magicbooklet-spike
  http://localhost:3300/api/mcp` (local scope, from the worktree) → `claude mcp get`: "OAuth: client_id
  configured, callback_port 33418".
- `claude mcp login magicbooklet-spike --no-browser` **needs a TTY**: with a pipe on stdin it printed the URL and
  exited 1 ("stdin isn't a terminal, so authentication can't be completed here"). Run in a pseudo-terminal
  (`scripts/spike-mcp-oauth/run-login-pty.py`) it printed the authorize URL, started its loopback listener on
  33418 anyway, and showed "Or paste the redirect URL here:". Its authorize request carried
  `redirect_uri=http://localhost:33418/callback`, `code_challenge_method=S256`, **no `scope`**, and
  `resource=http://localhost:3300/api/mcp`.
- Discovery it performed (Kong log, UA `Bun/1.4.4`): the 401 challenge's `resource_metadata` → our PRM
  (`{ resource: http://localhost:3300/api/mcp, authorization_servers: [http://127.0.0.1:56321/auth/v1] }`) →
  `/.well-known/oauth-authorization-server/auth/v1` 404 → `/.well-known/openid-configuration/auth/v1` 404 →
  `/auth/v1/.well-known/openid-configuration` 200 → `/auth/v1/.well-known/jwks.json`.
- The consent page showed `Claude Code (spike)`, `https://claude.com/claude-code`, `scope: email` (GoTrue's
  default), Approve → the browser landed on `http://localhost:33418/callback?code=…&state=…` (Claude Code's own
  page, title "Claude Code") and the login completed with no paste: "Authenticated with "magicbooklet-spike". Its
  tools are now available in Claude Code." `claude mcp get` → "Status: ✔ Connected" (it initialized against
  `/api/mcp` with the bearer). GoTrue logged `POST /oauth/token 200` from UA `Bun/1.4.4` for this client.
- **Not run:** `claude -p "Call the magicbooklet-spike whoami tool…" --allowedTools mcp__magicbooklet-spike__whoami`
  answered "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key
  instead", and no API key is in this environment, so the tool call from Claude Code and the `destructiveHint`
  treatment stay untested here. Server side, flipping `whoami` to `{ destructiveHint: true, readOnlyHint: false }`
  changed `tools/list` as expected. Claude Code's docs do not say that annotations change its permission
  prompts (a public feature request says the permission engine ignores them, and `/mcp` only labels read-only
  tools), so the plan should not rely on `destructiveHint` for the credit confirmation; `expected_cost_credits`
  on `create_media` is the guard.

### 5. Dynamic client registration

With `allow_dynamic_registration = true` (stack restarted; the metadata gained `registration_endpoint`):
`claude mcp logout`, `claude mcp remove`, `claude mcp add --transport http magicbooklet-spike
http://localhost:3300/api/mcp` (no client id, no port), `claude mcp login` → GoTrue logged `POST
/oauth/clients/register 201` and `auth.oauth_clients` gained `Claude Code (magicbooklet-spike)`,
`registration_type: dynamic`, `client_type: public`, `token_endpoint_auth_method: none`, `redirect_uris:
[http://localhost:53809/callback]` (a random port). The authorize, consent and exchange succeeded and Claude Code
reported Connected. Each fresh `claude mcp add` + login registers a new client row (Claude's docs say the same for
claude.ai with DCR), so a DCR-enabled production accumulates clients.

### 6. `resource` parameter

`resource=http://localhost:3300/api/mcp` on the authorize URL and in the token request: accepted and ignored;
`aud` stayed `authenticated`. (Claude Code and ChatGPT send it; nothing breaks.)

### 7. Scopes

- Omitted `scope` → `email` (consent page shows `email`; the token says `scope: "email"`).
- `scope=media:create posts:publish` → 302 to the client's redirect URI with `error=invalid_request`,
  `error_description=unsupported scope: media:create`; the consent page is never reached.
- `scope=profile email` and `openid email` accepted. The four supported scopes are `openid profile email phone`.
  So no scope-based authorization is possible; the consent page shows a fixed description of what the agent may
  do (the plan's decision stands).

### 8. Anonymous sessions

`signInAnonymously()` in node, then `getAuthorizationDetails(id)` → the full details (`user: { id }`, no email),
`approveAuthorization(id)` → a `redirect_url` with a code. GoTrue does not refuse guests. The consent page
skeleton checks `user.is_anonymous` and shows a sign-in wall instead of the client card; the route must refuse
`is_anonymous: true` tokens (the existing admission does: 403 `REGISTRATION_REQUIRED`).

### 9. Redirect URIs of the other clients (public docs)

| Client | Redirect URI(s) | Client identity | Source |
|---|---|---|---|
| Claude.ai web, Claude Desktop, Claude mobile, Cowork | `https://claude.ai/api/mcp/auth_callback` ("register exactly this") | CIMD when the AS advertises `client_id_metadata_document_supported` (GoTrue does not), else DCR, else a client id (+ optional secret) entered in the custom-connector dialog ("Use your own OAuth client") | https://claude.com/docs/connectors/building/authentication.md, https://claude.com/docs/connectors/custom/remote-mcp.md |
| Claude Code | `http://localhost:<port>/callback`; with `--callback-port P` exactly `http://localhost:P/callback` (v2.1.229 briefly sent `127.0.0.1`; 2.1.231+ `localhost`). Observed: `http://localhost:33418/callback`, and `http://localhost:53809/callback` under DCR | `--client-id` (+ `--client-secret`), or DCR, or its CIMD `https://claude.ai/oauth/claude-code-client-metadata` (declares `http://localhost/callback` and `http://127.0.0.1/callback`, port ignored; GoTrue has no CIMD) | https://code.claude.com/docs/en/mcp, observed here |
| ChatGPT connectors / Apps SDK | `https://chatgpt.com/connector_platform_oauth_redirect` only when the AS supports RFC 9207 (`authorization_response_iss_parameter_supported: true` and `iss` in authorization responses; GoTrue sends no `iss`), otherwise the per-connector `https://chatgpt.com/connector/oauth/{callback_id}` shown on the connector's management page | CIMD `https://chatgpt.com/oauth/client.json` (needs CIMD support), DCR, or a predefined client; sends `resource=` on authorize and token | https://developers.openai.com/apps-sdk/build/auth |
| Codex CLI | default `http://127.0.0.1/callback/<callback_id>` with the listener's ephemeral port inserted; pin with `mcp_oauth_callback_port` (global) or `mcp_servers.<name>.oauth.callback_port`; override with `mcp_oauth_callback_url` / `mcp_servers.<name>.oauth.callback_url`; register the exact URL `codex mcp add` prints | `--oauth-client-id` (+ `--oauth-client-secret`) → `[mcp_servers.<name>.oauth] client_id`, which skips registration; else CIMD `https://chatgpt.com/oauth/codex/<callback_id>/client.json` or DCR (`--oauth-client-registration cimd|dcr|auto`) | https://developers.openai.com/codex/mcp (redirects to https://learn.chatgpt.com/docs/extend/mcp) |
| Cursor | desktop `http://localhost:8787/callback`; web and Cursor Agents `https://www.cursor.com/agents/mcp/oauth/callback` (forum reports also mention `cursor://anysphere.cursor-mcp/oauth/callback` from older builds) | `auth: { CLIENT_ID, CLIENT_SECRET?, scopes? }` in the server entry (static id makes the desktop send only the desktop URL), else DCR (registers both URLs, public client) | https://cursor.com/docs/context/mcp |

Codex was not installed here; its row is documentation only.

## What phase 1 should do

Consent page (`/oauth/consent`, the Site URL + `authorization_url_path`):

- Read `authorization_id`; without a session send to `/login?next=/oauth/consent?authorization_id=…` (the login
  page's `next` passes `getSafeAuthNextPath` with the query intact; sign-in then returns here).
- With a guest session (`user.is_anonymous`) show a sign-in wall, never call `getAuthorizationDetails` with it.
- Call `getAuthorizationDetails(id)`; when the result has `redirect_url` (already consented) navigate there at
  once; otherwise show `client.name`, `client.uri` when present, the **redirect URI's host** (the MCP spec asks
  for it, and a loopback host deserves a warning: any local process can bind a port), the account, and the
  fixed description of what an agent may do (create media with the account's credits, publish posts as the
  account). The `scope` string is `email`/`openid`-class only; do not render it as permissions.
- Approve/Deny through `approveAuthorization` / `denyAuthorization` with `skipBrowserRedirect: true` and navigate
  to the returned `redirect_url` (Deny carries `error=access_denied`).
- Expose grants on the profile's Connected apps: `listGrants()` for the list, `revokeGrant({ clientId })` (camelCase)
  to disconnect; revocation signs the agent out at once through the admission check.

Token rules at `/api/mcp`:

- Run `evaluateUserFacingRouteIdentity` (signature via JWKS, `role: authenticated`, lifecycle RPC): it answers
  `session_valid: false` after a revoke and refuses a deleted or merged account; answer its 401 with
  `WWW-Authenticate: Bearer resource_metadata="https://magicbooklet.com/.well-known/oauth-protected-resource/api/mcp"`
  (mcp-handler's `withMcpAuth` builds exactly that header, with `error="invalid_token"`).
- Require `client_id` (403 `AGENT_TOKEN_REQUIRED`); refuse `is_anonymous` (403 `REGISTRATION_REQUIRED`); ignore
  `aud`, `scope` and `resource`. The proxy refuses `client_id` tokens on every other `/api` route.
- Optionally pin the accepted `client_id`s to the clients we registered (a table or env list) so a dynamically
  registered or unknown client cannot drive the server even with a valid user token.
- Refresh and expiry are the client's job; nothing to store server side.

Server plumbing confirmed: `createMcpHandler` from `mcp-handler@2.3.1` with `@modelcontextprotocol/server@2.4.0`
works in a Next 16 route (`export { handler as GET, handler as POST, handler as DELETE }`); the verified
`AuthInfo` reaches a tool as `extra.http.authInfo` in SDK v2 (`extra.authInfo` was v1), so put the claims in
`AuthInfo.extra`; `registerTool` takes `inputSchema: z.object({})`, an `outputSchema` when `structuredContent`
is returned, and `annotations`. `protectedResourceHandler({ authServerUrls: ['<supabase url>/auth/v1'] })`
derives `resource` from the request URL (`/.well-known/oauth-protected-resource/api/mcp` →
`https://magicbooklet.com/api/mcp`), and `metadataCorsOptionsRequestHandler()` answers `OPTIONS`. The
`.well-known` routes sit beside the existing `apple-app-site-association` and `assetlinks.json` ones and are
outside the proxy matcher.

Production switch-on (phase 1 or 3, owner's call):

- Dashboard → Authentication → OAuth Server: enable, Authorization Path `/oauth/consent` (Site URL is already
  `https://magicbooklet.com`); keep `supabase/config.toml` at `enabled = true` for local parity. Decide
  `allow_dynamic_registration`: **off** keeps the client list ours (Claude Code users run `claude mcp add
  --client-id <our public id> --callback-port <documented port>`; Codex users pin `mcp_oauth_callback_port` and
  set `client_id`; Cursor users set `auth.CLIENT_ID`; Claude.ai and ChatGPT users paste our client id); **on**
  gives zero-config Claude Code, Codex and Cursor at the cost of a growing `auth.oauth_clients` table and
  consent screens that name whatever the client registered. The spike's recommendation: start off, with
  documented public clients per surface, and reconsider in phase 3.
- Clients to create (all `token_endpoint_auth_method: none`, one per surface, with `client_uri` so the consent
  page can name and link them): Claude.ai/Desktop (`https://claude.ai/api/mcp/auth_callback`), Claude Code
  (`http://localhost:<our port>/callback`), ChatGPT (its per-connector URI, created when the connector is made),
  Codex (`http://127.0.0.1:<port>/callback/<id>` as printed by `codex mcp add`, or a pinned `callback_url`),
  Cursor (`http://localhost:8787/callback`, `https://www.cursor.com/agents/mcp/oauth/callback`). An ops script
  around `auth.admin.oauth.createClient` with the service key (ids may be printed; a confidential client's
  secret only to the owner's clipboard).
- Verify on production before announcing: the three discovery URLs, authorize/token without `apikey`, and the
  `WWW-Authenticate` challenge reaching Claude Code through Vercel (the route's 401 must carry it; the proxy's
  own 401 does not).

## Teardown record

`preview_stop` of `web-mcp-spike`; `supabase stop --project-id magicbooklet-mcp-spike --no-backup` (the other
stacks left running); `claude mcp logout magicbooklet-spike` and `claude mcp remove magicbooklet-spike` (local
scope of the worktree); the `web-mcp-spike` launch entry removed from `UGC copy/.claude/launch.json`; the
scratchpad's credential and env files deleted (`creds.json`, `tokens.json`, `pkce.json`, `cb.json`, `stack.env`,
`login.out`, the stack copy with `signing_keys.json`). The worktree and its throwaway code stay.
