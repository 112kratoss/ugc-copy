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
   surface, below. Phase 3 kept it off: every client connects with a pre-registered client
   ("Distribution", below).
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
| Codex CLI | `http://127.0.0.1:8977/callback/PPpoTd8EYBlz` (exactly this: Codex appends a callback ID derived from the server URL and inserts the pinned port; a `callback_url` without that ID is ignored, see "Distribution") | `codex mcp add magicbooklet --url https://magicbooklet.com/api/mcp --oauth-client-id <id>`, `callback_port = 8977` under `[mcp_servers.magicbooklet.oauth]` in `~/.codex/config.toml`, then `codex mcp login magicbooklet` |
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

## Distribution

How creators find the server and set it up (phase 3). Everything here reads one module,
`src/lib/mcp-client-directory.ts`: production's server URL, each surface's client id, the
callback ports and the exact redirect URIs. A surface whose client is not registered yet has a
`CLIENT_ID_PENDING_<SURFACE>` placeholder there, and the setup page shows it as coming soon, with
no command that could not sign in. The URLs and ids are production's on every deployment: a
preview cannot run the OAuth flow, whose consent page is on the production Site URL.

Dynamic client registration stays off. Every client in the directory connects with a
pre-registered public client: Codex with its callback port pinned, Cursor with a static client
id, so the client list stays ours and the consent screen names our own entries.

### Filling in a client id

When a surface's client is registered ("Registering a client", above, with the redirect URIs
`MCP_CLIENT_REDIRECT_URIS` lists for it):

1. Replace the placeholder in `MCP_CLIENT_IDS` with the id. The page shows that surface as
   available from the next deploy.
2. For Claude Code, put the same id in the plugin, `plugins/magicbooklet/.claude-plugin/plugin.json`
   (`mcpServers.magicbooklet.oauth.clientId`), and raise its `version`: to `1.0.0` for the first
   real id (it stays `0.x` while the id is a placeholder), and a step for any later change. An
   installed plugin updates only when its version changes, so a copy installed with the
   placeholder would otherwise never sign in. `mcp-distribution-manifests.test.ts` fails until
   the id and the version agree with the directory.
3. Run the distribution tests and validate the plugin:
   `npx vitest run src/__tests__/developers-mcp-page.test.tsx src/__tests__/mcp-client-directory.test.ts src/__tests__/mcp-distribution-manifests.test.ts`,
   then `claude plugin validate --strict .` from the repository root.
4. After the deploy, connect once from that client against production ("Production switch-on
   checks").

### Setup facts per client

Checked against each client's documentation on 2026-11-10; the spike's table (research note,
section 9) has the sources.

- **Claude.ai and Claude Desktop**: Customize → Connectors → Add custom connector, the server
  URL, and the client id under Advanced settings (a two-step dialog calls it "Use your own OAuth
  client"), secret blank. A connector added on claude.ai also appears in Claude Desktop and the
  mobile apps. The redirect is `https://claude.ai/api/mcp/auth_callback`.
- **Claude Code**: `claude mcp add --transport http --client-id <id> --callback-port 8976 magicbooklet https://magicbooklet.com/api/mcp`,
  then `/mcp` → Authenticate (or the plugin, below). The redirect is
  `http://localhost:8976/callback`; the port must be free while the person signs in.
- **ChatGPT**: Plugins → + → Add custom MCP server, the URL under Connection, OAuth with the
  client id, then Create as a plugin; workspace policies decide whether custom servers are
  allowed. The redirect is per connector, `https://chatgpt.com/connector/oauth/{callback_id}`,
  shown on the connector's management page once it exists (GoTrue sends no RFC 9207 `iss`, so
  ChatGPT's stable `https://chatgpt.com/connector_platform_oauth_redirect` does not apply).
- **Codex**: `codex mcp add magicbooklet --url https://magicbooklet.com/api/mcp --oauth-client-id <id>`
  writes `[mcp_servers.magicbooklet]` with `url`, and `[mcp_servers.magicbooklet.oauth]` with
  `client_id` (a configured client id skips registration). Two things decide the redirect URI:
  - The port: Codex listens on a random one unless pinned, and GoTrue matches ports exactly, so
    the person adds `callback_port = 8977` under `[mcp_servers.magicbooklet.oauth]` (the global
    `mcp_oauth_callback_port = 8977` works too). The setup page shows the whole block.
  - The path: with no `iss` from the authorization server, Codex appends a server-specific
    callback ID to `http://127.0.0.1/callback`, and ignores a configured `callback_url` that does
    not end in it. The ID is the first 9 bytes of the SHA-256 of the server URL, base64url with
    no padding (`callback_id_from_server_url` in openai/codex,
    `codex-rs/rmcp-client/src/oauth_callback.rs`), `PPpoTd8EYBlz` for ours, the same for every
    creator; `mcp-client-directory.test.ts` recomputes it with Codex's own test vector. So the
    client's one redirect URI is `http://127.0.0.1:8977/callback/PPpoTd8EYBlz`.

  Then `codex mcp login magicbooklet` (`--no-browser` prints the URL and takes the pasted
  redirect). If GoTrue ever sends `iss` and advertises
  `authorization_response_iss_parameter_supported`, Codex changes how it picks the callback:
  register what `codex mcp add` then prints.
- **Cursor**: `"auth": { "CLIENT_ID": "<id>" }` on the server's entry in `~/.cursor/mcp.json`
  (every project) or `.cursor/mcp.json` (one project). With a static client id the desktop app
  sends only `http://localhost:8787/callback`; the web and Cursor Agents send
  `https://www.cursor.com/agents/mcp/oauth/callback`. Register both. With no `scopes` given,
  Cursor asks for what the authorization server's metadata lists.

### The setup page

`/developers/mcp` (`src/app/developers/mcp/`): what a connected agent can do, that every charge
is quoted first, how the account stays in control (consent, Connected apps, the one-hour
sign-in), and one block per client with a copy button on each command. It is public and
indexable (`createMetadata`, in the sitemap), drawn with `globals.css` alone, and static. The
protected-resource metadata names it as `resource_documentation`. `developers-mcp-page.test.tsx`
draws both states of every block.

### The Claude Code plugin marketplace

This public repository is a Claude Code plugin marketplace: `.claude-plugin/marketplace.json`
(name `magicbooklet`) lists one plugin, `plugins/magicbooklet/`, which declares the server with
the Claude Code client and port 8976, and two skills: `create-ugc-ad` (models, quote, the
person's yes, `create_media` with `expected_cost_credits` and one `idempotency_key`, the wait,
an offer to publish) and `publish-creation` (a finished creation, a title that is no
placeholder, `publish_post`). A creator installs it with:

```bash
claude plugin marketplace add 112kratoss/ugc-copy
```

```bash
claude plugin install magicbooklet@magicbooklet
```

and signs in with `/mcp`. Adding the marketplace clones this repository; `--sparse .claude-plugin
plugins` on the first command checks out only those two folders.

- The server is declared in `plugin.json`'s `mcpServers`, not in a `.mcp.json`: this
  repository's agent guard refuses every `.mcp.json` to its agents, which would leave the file
  unreadable to a reviewer, and the test refuses one beside the manifest.
- The skills pre-approve only the server's free reads (`allowed-tools`); `create_media`,
  `enhance_prompt`, `publish_post`, `delete_post` and `upload_input` always reach the person's
  permission prompt, which the manifest test holds.
- Any change to the plugin raises `version` in `plugin.json` (see "Filling in a client id").
- `claude plugin validate --strict .` checks the marketplace and `claude plugin validate --strict
  plugins/magicbooklet` the plugin and its skills; both passed on Claude Code 2.1.302.

### MCP registry

`server.json` at the repository root is the official MCP registry entry,
`com.magicbooklet/mcp`: the remote `streamable-http` server at `https://magicbooklet.com/api/mcp`,
its website `/developers/mcp` and this repository, in the registry's 2025-12-11 schema. The
namespace is proven by the domain: `/.well-known/mcp-registry-auth` serves
`v=MCPv1; k=ed25519; p=<public key>` as plain text (`src/lib/mcp-registry-auth.ts` holds the
public key). The private key is not in the repository, the app's environment or Vercel: the
operator holds it, and whoever holds it can publish and change `com.magicbooklet/*` entries, so
after the first publish it goes into the owner's password manager.

Publishing, once the route is live in production (the branch that added it merged and
released):

1. Install the publisher: `brew install mcp-publisher` (or the release binary from
   `github.com/modelcontextprotocol/registry/releases`), and check `mcp-publisher --help`.
2. Fetch the proof as the registry does, from Google Cloud with no redirects and a 10-second
   timeout:

   ```bash
   curl -sS -o - -w '\n%{http_code}\n' -H 'Accept: text/plain' -A 'mcp-registry/1.0' https://magicbooklet.com/.well-known/mcp-registry-auth
   ```

   It must answer the record and `200`. A Vercel firewall or bot rule that challenges
   non-browser clients fails the login with `token exchange failed with status 401`.
3. From the repository root, log in with the key's 32-byte seed in hex. macOS's own `openssl`
   is LibreSSL, which has no Ed25519, so use OpenSSL 3 (`brew install openssl@3`). The seed
   goes into a variable and is never printed; it is in the publisher's argument list while the
   login runs, so run it on the operator's own machine:

   ```bash
   PRIVATE_KEY="$(/opt/homebrew/opt/openssl@3/bin/openssl pkey -in <private-key.pem> -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"; mcp-publisher login http --domain magicbooklet.com --private-key "$PRIVATE_KEY"; unset PRIVATE_KEY
   ```

   The login prints an "Expected proof record"; it must match what step 2 fetched.
4. Publish: `mcp-publisher publish` ("Successfully published", with the version), then check
   `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=com.magicbooklet/mcp"`.

A later publish (a new description, say) needs a new `version`: the registry refuses one it
already has. `server.json`'s version and the server's own `MCP_SERVER_VERSION` move together;
`mcp-registry.test.ts` holds them equal.

The DNS alternative needs no deploy: a TXT record on the apex, `magicbooklet.com`, never under
a selector such as `_mcp-auth.magicbooklet.com`:

```text
magicbooklet.com. IN TXT "v=MCPv1; k=ed25519; p=<public key>"
```

then `mcp-publisher login dns --domain magicbooklet.com --private-key "$PRIVATE_KEY"` with the
seed as above (`dig TXT magicbooklet.com +short` shows the record first). To rotate the key, or
after losing it: generate a new pair with OpenSSL 3 (`openssl genpkey -algorithm ed25519`; the
public key is `openssl pkey -in <file> -pubout -outform DER | tail -c 32 | base64`), put the
public key in `MCP_REGISTRY_PUBLIC_KEY` and release, or replace the TXT record, then log in
with the new private key. Remove a retired TXT record: a stale one is tried first.

### Anthropic's Connectors Directory

The directory does not list AI media generation without a written exception from Anthropic, so
listing needs the owner to ask for one. Until then the custom connector, the Claude Code
command and this repository's plugin marketplace need no review. A draft the owner can send to
mcp-review@anthropic.com:

> Subject: Written exception request: Magic Booklet MCP server (AI image and video generation)
>
> Hello,
>
> Magic Booklet (https://magicbooklet.com) is a platform where creators make AI images and
> videos and share them with a community. We run a remote MCP server at
> https://magicbooklet.com/api/mcp and would like it listed in the Connectors Directory. As we
> understand the directory's policy, AI media generation needs a written exception, so we are
> asking for one.
>
> A connected agent works as the signed-in creator: it lists our models, prices a run, creates
> images and videos with the creator's own credits, follows a run to the end and, when asked,
> publishes a creation to the creator's profile.
>
> - Sign-in is OAuth 2.1 with PKCE. The creator approves each app on our consent page; guest
>   sessions cannot connect, and the creator can disconnect an app at any time.
> - Every charge is quoted first: a run must carry the price the agent confirmed and is never
>   charged more, a failed run refunds itself, and agents cannot buy credits.
> - Posts an agent publishes follow the same rules and moderation as posts made on our site and
>   app, including our child-safety policy (https://magicbooklet.com/child-safety), with a daily
>   limit on agent posts.
> - Access tokens last an hour, and we can switch the whole server off at once.
>
> Setup and documentation: https://magicbooklet.com/developers/mcp. Registry entry:
> com.magicbooklet/mcp. We are glad to provide a reviewer account with credits.
>
> Thank you,
> [name], Magic Booklet (info@magicbooklet.com)

### ChatGPT directory submission

A developer-mode connector works for anyone whose workspace allows custom servers; a listing in
ChatGPT's directory is a separate submission that OpenAI reviews. Before submitting:

- No selling or upselling credits inside tool output. A short balance answers
  `INSUFFICIENT_CREDITS` with the balance and the shortfall only, never a pack, a price or a
  purchase link (`mcp-tool-results.ts`, `mcp-server-service.ts`); keep it that way in every new
  tool, its text and its structured content.
- Tool annotations must match what each tool does (`readOnlyHint` on the reads,
  `destructiveHint` on `create_media`), and a reviewer needs an account with credits.
- Register on the ChatGPT client the exact redirect URI ChatGPT's management page shows for the
  server (the callback-ID form, since GoTrue sends no `iss`) before the review starts.
