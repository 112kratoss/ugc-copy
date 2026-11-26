# The app's own OAuth server for MCP (2026-11-26)

Status: **shipped 2026-11-26, archived the same day.** Built in #935 and hardened in #936 (live as
`960e702be`), cut over on production that day (`MCP_AUTHORIZATION_SERVER=app`, Supabase Auth's
OAuth server switched off, the sessions and consents it had issued ended: "Cutover, as done"),
and then the follow-up removed the Supabase path, the flag and the client import from the code,
so the app's server is the only behaviour. This file is the record of the design, the proof and
the cutover, not a plan still open; "the flag", "the follow-up" and the Supabase path below
describe the code before that. Operating the server: `docs/mcp-server-operations.md`, "The app's
own authorization server". It moved here from `docs/plans/`, the path migrations
`20261126121704` and `20261126151150` still name. Owner's decision, 2026-11-26: "our own token
exchange".

## Why

An agent connects to `/api/mcp` and `/api/mcp/posts` through OAuth. Until now Supabase Auth's
OAuth 2.1 server issued the agent's token, so that token was a Supabase session: the app refused
it on every route but the MCP ones (`agent-token.ts`), and that was the only line, because the
same token is valid at the Supabase project itself (Auth, PostgREST, Storage).

The requirement: **no OAuth client can obtain a Supabase JWT, refresh token or session by any
path.** So the app is the authorization server, the agent's token is an opaque string only this
app can read, and Supabase's OAuth server ends up switched off. A proxy in front of Supabase's
token endpoint would not meet it: a client could call Supabase directly.

## What an agent holds afterwards

| | Before | After |
|---|---|---|
| Access token | Supabase JWT with `client_id` | `mbat_` + 256 random bits, meaningless outside this app |
| Refresh token | Supabase refresh token | `mbrt_` + 256 random bits |
| Valid at Supabase (Auth, PostgREST, Storage) | yes, as the creator | no: not a JWT |
| Bound to | nothing | one grant: one account, one client, one MCP server |

## Tables (migration `20261126121704_agent_oauth_server.sql`)

All four: RLS on, no policy, every grant revoked from `anon` and `authenticated`, read and written
by the service role only. Secrets are stored as `base64url(SHA-256(value))`, never the value.

- `agent_oauth_clients`: `client_id` (text, the ids already registered), `client_name`,
  `client_uri`, `redirect_uris text[]`, `token_endpoint_auth_method` (`none`,
  `client_secret_post`, `client_secret_basic`), `client_secret_hash`, `surface` (`full` or
  `posts`: the widest server it may be granted), `disabled_at`.
- `agent_oauth_authorizations`: one row per `/oauth/authorize` request (`id` is the
  `authorization_id` the consent page carries, `mbar_…`): client, redirect URI, surface, `state`,
  `code_challenge`, the account it was shown to (`user_id`), `consent_token_hash`, `status`
  (`pending`, `approved`, `denied`, `consumed`), `code_hash`, `code_expires_at`, `grant_id`,
  `expires_at` (10 minutes).
- `agent_oauth_grants`: one row per approval: `user_id`, `client_id`, `surface`, `created_at`,
  `last_used_at`, `revoked_at`, `revoked_reason` (`user`, `client`, `reuse`, `code_replay`,
  `operator`).
- `agent_oauth_tokens`: `token_hash` (primary key), `kind` (`access`, `refresh`), `grant_id`,
  `expires_at`, `used_at` (a refresh token's first use).

Functions, `service_role` only: `agent_oauth_consume_code` (single use; a replayed code revokes
its grant), `agent_oauth_issue_tokens`, `agent_oauth_rotate_refresh_token` (rotation and reuse
detection in one transaction), `agent_oauth_token_admission` (the MCP routes' one round trip:
token, grant, client and the account's lifecycle), `agent_oauth_revoke_grants`,
`agent_oauth_revoke_token`, `agent_oauth_import_supabase_clients` (cutover: copies the registered
clients, a confidential one's secret hash included, so no client id or secret changes).

## Endpoints

| Path | What |
|---|---|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata. Issuer: the site origin. |
| `GET /.well-known/oauth-protected-resource[/api/mcp[/posts]]` | RFC 9728, as before; names the app as authorization server once the flag says so. |
| `GET /oauth/authorize` | Code flow start. Validates, stores the request, sends the browser to `/oauth/consent?authorization_id=mbar_…`. |
| `POST /oauth/token` | `authorization_code` and `refresh_token` grants. |
| `POST /oauth/revoke` | RFC 7009: a client ends its own grant. |
| `POST /api/oauth/consent` | The consent page's answer (web session, registered accounts). |
| `GET`, `DELETE /api/oauth/grants` | Connected apps: list and disconnect. |

Rules: `response_type=code` only; PKCE `S256` required (no `plain`, no missing challenge);
`redirect_uri` required and matched as an exact string; pre-registered clients only; a parameter
sent twice is refused; `resource` (RFC 8707) must be one of the two MCP URLs of this origin and
binds the grant to that server; a `posts` client is never granted the full server. The confidential
client authenticates with its secret (`client_secret_post` or `client_secret_basic`), compared in
constant time. Authorization code: 2 minutes, single use. Access token: 1 hour. Refresh token:
rotated on every use, each valid 90 days from issue.

Consent: the page keeps its look and its rules (registered accounts only, the fixed access list,
the posting-only list when the grant is for the posting server). It is rendered for the signed-in
account, which binds the request to that account and mints a one-time consent token into the
page. The answer is a same-origin `POST` carrying the web session's bearer token, the
`authorization_id` and the consent token; the adapter also checks `Origin` and `Sec-Fetch-Site`.
`X-Frame-Options: DENY` is the site-wide header that keeps the page out of a frame, unchanged
(the CSP's `frame-ancestors 'none'` is sent report-only today, so it reports and does not block).

MCP admission (`agent-oauth-admission.ts`): hash the bearer token, one `agent_oauth_token_admission`
round trip, then the same answers the proxy's evaluator gives: unknown, expired or revoked 401
with the `WWW-Authenticate` challenge; account gone 401; `deleting` 409; banned 401; `merged` 409;
guest 403 `REGISTRATION_REQUIRED`; a posting grant at `/api/mcp` 403 `AGENT_SURFACE_NOT_ALLOWED`.
The tools then run on a per-request service-role client told who the admitted account is; the
agent's token is stripped from the request the services see.

Rate limits (`check_backend_rate_limit`): authorize 30 per minute per network address; token 600
per minute per network address (a hosted client makes every creator's exchanges and refreshes
from a few addresses of its own); revoke 30 per minute per network address; the consent answer and
Disconnect 20 per minute per account. None is keyed on the client id, which is public: a limit
there would let anyone lock a client out. No token, code, secret or consent token is logged.

## The flag

`MCP_AUTHORIZATION_SERVER`, read per request (`agent-oauth-mode.ts`):

| Value | Metadata names | `/oauth/*` and `/api/oauth/*` | MCP routes accept |
|---|---|---|---|
| unset or `supabase` | Supabase | answer 404 | Supabase agent JWTs (today's behaviour) |
| `both` | the app | on | app tokens, and Supabase agent JWTs already issued |
| `app` | the app | on | app tokens only; any JWT is refused |

`MCP_SERVER_DISABLED=1` still switches the MCP routes off in every mode.

## What each existing file becomes

- `agent-token.ts`: unchanged rule for Supabase JWTs (still refused off the MCP routes while
  Supabase's server is on); gains the app token's prefix test.
- `mcp-route-adapter-service.ts`: picks the admission by token shape and flag; app tokens go to
  `agent-oauth-admission.ts`, JWTs to the existing evaluator until `app`.
- `mcp-server-service.ts`: unchanged. Its one use of the caller's client beyond
  `getVerifiedAuthUserResult` is signing Storage links for paths already checked against
  `userId` (`resolveGenerationMediaSource`), which the service client does as the web's run
  steps already do.
- `identity-admission-assertion.ts`: `registerAdmittedIdentity(client, user)` lets a route that
  authenticated the caller itself tell the services who it is, with no assertion header.
- `oauth-protected-resource-metadata.ts`: `authorization_servers` follows the flag.
- `oauth-consent-service.ts`, `/oauth/consent`: the page loads an `mbar_` request on the server
  and answers through `/api/oauth/consent`; a GoTrue id kept the old client-side path until
  `app`, where it is answered as unavailable.
- `connected-apps.ts`, `ConnectedApps.tsx`: list and revoke the app's grants through
  `/api/oauth/grants`, merged with Supabase's. With Supabase's server off its grants API answers
  as disabled, which the list reads as none; the code still asks until the follow-up removes it.
- `route-identity-policy.ts`: `/api/oauth/consent` and `/api/oauth/grants` are `registered`.
- `mobile-push-unregister-service.ts`: "Sign out everywhere" ends every grant of the account on
  the app's server. Both clients already send `POST /api/mobile/notifications/unregister` with
  `scope: 'account'` just before a global sign-out, installed phone apps included, so the server
  ends the grants there (`disconnectEveryAgentClient`) and no client changes. An app's access is
  no longer one of the account's sessions, and the consent page says signing out everywhere
  ends it. Like the push tokens it rides with, it is best effort: a failure is logged
  (`agent_access_sign_out_everywhere_failed`) and answered 500, and the sign-out goes on;
  Connected apps is the certain way.
- `scripts/ops/oauth-clients.ts`: `--app` turns `list` and `create` to `agent_oauth_clients`, and
  `import`, `disable`, `enable` and `rotate-secret` exist only there; without the switch `list`
  and `create` are still Supabase's, until the follow-up.
- `server-helpers.ts`: `createRequestServiceClient()`, the per-request service client the tools
  get behind an app token.
- `agent-tool-calls.ts`: unchanged; `client_id` is the app client's id, which is the same id.

## Decisions

1. **Opaque tokens looked up by hash**, not JWTs signed by the app. Rejected: self-signed JWTs
   (no round trip, but revocation waits for expiry and a signing key becomes one more secret).
2. **Clients in a table**, imported once from Supabase with their ids and secret hash. Rejected:
   clients in code (a confidential secret hash and ChatGPT's per-account redirect do not belong
   in a public repo) and new ids (every setup command and the directory listing would change).
3. **No dynamic client registration.** Every client in `mcp-client-directory.ts` signs in with a
   static id today (Claude, Claude Code, Cursor, Codex, ChatGPT, the two posting-only Claude
   clients); none needs it. Rejected: open registration, which lets any program name itself.
4. **The request is stored and carried as `authorization_id`**, as GoTrue did, so the consent
   page, its sign-in round trip and its tests keep their shape. Rejected: the whole request in
   the query string (long, and nothing to bind the consent token to).
5. **Consent is asked every time.** Rejected: skipping the screen for a client approved before,
   which for a loopback client lets any local program collect a code silently.
6. **Refresh reuse grace of 10 seconds**: a second use of a rotated token inside 10 seconds gets
   a fresh pair (two Claude Code processes share one stored token and race); after that it
   revokes the grant. The cost, accepted: whoever copies a refresh token and uses it inside those
   10 seconds holds a second chain that rotates on its own and that reuse detection never sees;
   it ends only with the grant (Disconnect, Sign out everywhere, 90 days unused). Rejected: zero
   grace, which disconnects honest clients, and Supabase's own default is the same 10 seconds.
7. **Refresh tokens last 90 days unused, with no absolute cap.** Rejected: 30 days (a creator who
   posts monthly would reconnect each time) and non-expiring (an abandoned grant stays live).
8. **A full grant is accepted at the posting server; a posting grant only there.** The posting
   tools are a subset, and a client that omits `resource` gets its client's default surface.
   Rejected: strict audience equality, which breaks a full client connected to the posting URL
   and protects nothing. Posting-only is said twice and either is enough: the client's row
   (`surface = 'posts'`) and the code's list (`MCP_POSTING_ONLY_CLIENT_IDS`), asked at authorize
   and at admission, so a row registered `full` by mistake does not widen a listed client.
9. **No `iss` in the authorization response** (RFC 9207 not advertised): Codex chooses its
   redirect path by that flag, and its registered redirect is the form it sends today.
10. **Scopes are not permissions.** Any `scope` is accepted and the token response says `mcp`;
    access is the grant's surface. Rejected: per-tool scopes, which no client asks for.
11. **Tools run on the service client with explicit owner checks**, not a JWT minted for the
    account. Rejected: a server-side Supabase session per agent (it is the thing being removed).
12. **A flag with a `both` stage**, so the new server is proven on production with one real
    connection before anything is refused. Rejected: a hard switch at deploy.
13. **`/oauth/authorize` and `/oauth/token` outside `/api`**: conventional paths, outside the
    proxy's bearer admission, which they do not use.

## Cutover

The runbook has the commands (`docs/mcp-server-operations.md`, "The app's own authorization
server" → "Cutover"). Steps 1 to 3 change nothing a creator can see. Every step from 2 on is the
owner's to approve.

1. Merge and deploy with the flag unset. The migration creates empty tables. Nothing changes.
2. Import the clients: `npm run ops:oauth-clients -- import --apply` against production. It
   copies each Supabase OAuth client (id, name, redirect URIs, auth method, secret hash) into
   `agent_oauth_clients`, marks the two posting-only ids `posts`, and prints the ids and names.
   It skips a secret hash that is not the 43-character SHA-256 form (then the directory client
   needs a new secret, `rotate-secret`, and the listing an update).
3. Set `MCP_AUTHORIZATION_SERVER=both` on Vercel production and redeploy.
4. Prove it on production with the owner's own account: reconnect Claude Code, approve on the
   consent page, run `list_models` and one `publish_post` with `visibility: private`; check
   Connected apps lists it and that Disconnect ends it.
5. Set `MCP_AUTHORIZATION_SERVER=app` and redeploy. Supabase-issued agent tokens are now refused
   at the MCP routes; every connected agent is asked to sign in again (two accounts on
   2026-11-26, both the owner's).
6. In the Supabase dashboard, Authentication → OAuth Server → Apps: delete each app, which
   deletes its consents and sessions, so no old refresh token works.
7. Same page: switch the OAuth server off.
8. Wait one hour: an access JWT Supabase issued before step 6 keeps its signature until it
   expires. Its session is gone, so Auth refuses it and so does every table and bucket behind
   the `authenticated_identity_active` policy, but the requirement is met in full only once the
   last one has expired. Then check that Supabase's authorization-server metadata no longer
   answers and that no session with an OAuth client remains.
9. Distribution. The Claude Code plugin, the setup page's commands, the MCP registry entry
   (`server.json`) and the directory listings name the MCP URL and a client id, never an
   authorization server, and the import keeps every id and the directory client's secret: nothing
   to republish or resubmit. Reconnect once from the Claude connectors-directory listing and from
   ChatGPT to confirm.
10. Follow-up PR: delete the `supabase` and `both` branches, `supabase.auth.oauth` from the
    consent page and Connected apps, the Supabase half of `ops:oauth-clients`, and
    `[auth.oauth_server]` from `supabase/config.toml`; make `app` the only behaviour.

Rollback before step 6: set the flag back to `supabase` and redeploy; Supabase's clients and
grants are untouched until then.

## Cutover, as done (2026-11-26, on the owner's word)

1. #935 merged and released with #934 as `2e37141bb`; the migration applied.
2. The seven clients imported on production, none skipped, the two posting-only ones as `posts`;
   redirect URIs and the directory client's secret hash equal to Supabase's.
3. `both` set in Vercel Production and released by the manual Production release run
   (`expected_abandoned_reclaim_effective=true`).
4. Hardening from the security review merged and released (#936, `960e702be`).
5. Proved with the owner's account, the consent answered in the owner's browser: an opaque token,
   twelve tools, `list_models` and `list_creations`; the token refused at another API route and
   by Supabase (Auth 403, PostgREST 401, its refresh endpoint 400); a refresh rotated;
   `/oauth/revoke` ended it at once.
6. `app` set and released: every JWT is answered 401 at the MCP routes, and a connector holding
   a Supabase-issued token was told to sign in again.
7. What Supabase's server had issued was ended in SQL: 7 sessions with an OAuth client (their
   163 refresh tokens with them), 3 consents, 4 pending requests. The seven rows of
   `auth.oauth_clients` were left: with the server off they are inert, and deleting them was
   not needed to end anything. Ordinary sign-in sessions were not touched.
8. Supabase dashboard → Authentication → OAuth Server: switched off and saved (the switch alone
   does not save). Its metadata, authorize and token endpoints answer 404; Auth is healthy.
9. Checked at 16:57 UTC: no session with an OAuth client, no consent; the app's metadata 200, a
   request from a registered client goes to the consent page, `/api/mcp` and `/api/mcp/posts`
   challenge with 401. Connected apps on `/profile/edit` loads for a signed-in account with
   Supabase's server off ("No apps connected"). An access JWT Supabase issued before step 7 had
   at most the rest of its hour to run, and nothing behind it.

There is no rollback by the flag any more: `supabase`, or the variable lost, now means every
agent call is answered 401 (Supabase issues nothing). Going back would mean switching Supabase's
server on again, `both`, and every agent signing in afresh.

Not done by the cutover: reconnecting each client. Every creator's agents sign in again on their
next call (two accounts, both the owner's). The Claude connectors-directory listing and ChatGPT
keep their client id (and the directory its secret); one reconnect from each confirms it.

## Proof

On a throwaway local stack (GoTrue v2.186.0, CLI 2.75.0, never production), 2026-11-26, with the
flag `app` and the real route handlers:

- authorize → consent → token issues `mbat_`/`mbrt_` tokens; `tools/list`, `list_creations` and a
  private `publish_post` work and write `agent_tool_calls` rows under the client's id;
- the access token is refused by every Supabase endpoint tried (Auth 403, PostgREST 401, Storage
  400) and the refresh token by Supabase's token endpoint (400): neither is a Supabase credential;
- a Supabase session JWT and a Supabase agent JWT are both answered 401 at `/api/mcp`, and an
  agent's token of either kind cannot answer `/api/oauth/consent`;
- a posting-only client is refused the full server at authorize and at the route;
- a replayed code, a reused refresh token, Disconnect, `/oauth/revoke` and a ban each end access
  at once.

The migration's rules are held by `supabase/tests/database/agent_oauth_server.test.sql` (95
assertions) on a full replay, and `tests/e2e/oauth-consent.spec.ts` draws the consent page for
the app's own requests. The run's record is kept outside the repository, with the security
review it belongs to.

## After the security review

A second review, of the merged code (2026-11-26), found nothing critical or high. Its findings
and what became of them (migration `20261126151150_agent_oauth_hardening.sql`):

1. **Token rows could be grown without end** by an account refreshing its own grant in a loop.
   Now a grant is given at most twelve refresh tokens in any hour, the one issued with it
   included: the request past that is answered 429 with `Retry-After` and changes nothing. An
   account holds twenty live grants per client, one more ending the oldest (`superseded`), and
   keeps twenty ended ones; ended grants are purged after thirty days. A grant driven as hard as
   it can be holds about 26,000 small rows over the ninety days a used token is kept. The same
   count bounds how many pairs the reuse grace can hand out.
2. **A grant outlived account recovery.** A grant now carries a digest of the account's stored
   password hash and ends at its next use once that has changed (`credentials_changed`): a
   password change or reset ends every app connected under the old one, with no client's help.
   An account with no password (Google, Apple) is unaffected. "Sign out everywhere" ends grants
   whatever the flag says, so a grant made under `both` does not outlive a sign-out made during
   a rollback. The server ends them before the request's own rate limit and marks every answer
   where it could not; with that mark, or with no answer at all, the web asks once more, signs
   out all the same, and tells the person their connected apps may still be connected.
3. **The import trusted Supabase's redirect URIs.** The tables now hold every redirect URI to
   https, or http on a loopback host, in lower case, with no fragment and no userinfo, and the
   import skips and names a client that fails it (`redirect_uris_unusable`). `create --app`
   applies the same rule in words (`isStorableRedirectUri`). The page already followed only an
   http(s) redirect; `buildAuthorizationResponseUrl` now builds no other.

A third review, of these fixes, found nothing critical or high and is answered in the same
change: the ordering against the rate limit above, the migration's table order (the order the
functions lock in, so it waits for a token exchange in flight), the count of ended grants, and
the rule's TypeScript twin.

Left as they are, on purpose: the first account to render a request binds it (the consent page
is what keeps that from being silent), and a confidential client may send its secret in the body
or a Basic header whichever it registered with.

## Known limits

- A used refresh token's hash is kept until it expires (90 days) so a late reuse is recognised:
  a grant refreshed hourly holds about 2,000 small rows, and one at its limit of twelve an hour
  about 26,000. `agent_oauth_tokens` has a row budget in `operational-table-growth.ts`.
- The flag defaults to `supabase`, so a deployment that loses the variable reverts to the old
  server; after step 7 that means every agent call is 401, which is loud. The follow-up removes
  the default.
- `agent_oauth_clients` has no command to add a redirect URI to an existing client yet.
- `import`'s dry run reads Supabase's clients through the admin API, which shows no secret hash,
  so only `--apply` can say that a confidential client's hash is in another form
  (`secret_hash_unusable`). It changes nothing for that client; read its output.
- A grant ends when the account's stored password hash changes, which is a password change or
  reset. Supabase Auth also rewrites that hash at sign-in for a hash it wants to upgrade (an
  imported argon2 or scrypt hash, a bcrypt cost other than its default): such an account's apps
  would be asked to connect again once. On 2026-11-26 production had none: 75 accounts with no
  password and 8 with a bcrypt hash at the default cost.
- Sign out everywhere ends the app's grants through the account-wide push-token request. The web
  says so when that failed; an installed phone app only logs it, and a build older than that
  request (before 2026-10-17) does not send it. A password change is the certain way to end
  every app at once, and Connected apps the way to end one.
