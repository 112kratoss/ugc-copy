# MCP server operations

The agents' MCP server lives at `https://magicbooklet.com/api/mcp`. An agent in Claude.ai, Claude
Desktop, Claude Code, ChatGPT, Codex or Cursor connects to it, signs a creator in through
Supabase Auth's OAuth 2.1 server, and then creates media with that creator's credits and
publishes it as that creator (phase 1: `list_models`, `get_model`, `quote_generation`,
`create_media`, `get_generation`, `list_creations`, `enhance_prompt`; phase 2: `upload_input`,
`publish_post`, `get_post`, `delete_post`, and the `agent_tool_calls` audit table every call
writes; phase 4: `request_upload`, and `publish_post` from files the agent staged, so an agent
can post media made elsewhere, and `publish_post` with neither a creation nor files, a text post,
with prompts, guides or links attached as a resource, free or at a price the person set: "Media
made elsewhere" and "Text posts, resources and prices", below). The plan, the decisions behind it
and the later phases are `docs/plans/agent-mcp-server-plan-2026-11-09.md`; this runbook is what
an operator does.

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
| Claude Code | `http://localhost:8976/callback` (our documented port; the URI must match exactly, so the port is fixed) | `claude mcp add --transport http --scope user --client-id <id> --callback-port 8976 magicbooklet https://magicbooklet.com/api/mcp` (user scope: the default, `local`, ties the server to the folder the command ran in), then `/mcp` (or `claude mcp login magicbooklet`, which needs a terminal) |
| ChatGPT (connectors, Apps SDK) | the per-connector `https://chatgpt.com/connector/oauth/{callback_id}` shown on the connector's management page: create the connector first, then register its URI (GoTrue sends no RFC 9207 `iss`, so ChatGPT's shared redirect does not apply) | Settings → Connectors → Create (developer mode) with the URL and the client id |
| Codex CLI | `http://127.0.0.1:8977/callback/PPpoTd8EYBlz` (exactly this: Codex appends a callback ID derived from the server URL and inserts the pinned port; a `callback_url` without that ID is ignored, see "Distribution") | `codex mcp add magicbooklet --url https://magicbooklet.com/api/mcp --oauth-client-id <id>`, `callback_port = 8977` under `[mcp_servers.magicbooklet.oauth]` in `~/.codex/config.toml`, then `codex mcp login magicbooklet` |
| Cursor | `http://localhost:8787/callback` (desktop) and `https://www.cursor.com/agents/mcp/oauth/callback` (web and Cursor Agents) | `auth: { CLIENT_ID: "<id>" }` on the server entry in `.cursor/mcp.json`, or the deeplink |

A redirect URI must match exactly: scheme, host, port and path (`127.0.0.1` is not `localhost`;
no port-agnostic loopback). Supabase accepts and ignores the `resource` parameter clients send
(it binds a token to no resource), which is why the route requires the `client_id` claim instead.
The token's `scope` is only `openid profile email phone` class and is never shown as permissions;
the consent screen shows the fixed description of what an agent may do.

### Registered clients (production, 2026-11-09)

Dynamic client registration is off on production (its metadata has no `registration_endpoint`),
so these public clients are the only ones. Their ids are public values and live in
`MCP_CLIENT_IDS` (`src/lib/mcp-client-directory.ts`), which the setup page and the Claude Code
plugin read.

| Client | Client id | Redirect URIs registered |
|---|---|---|
| Claude (Claude.ai, Claude Desktop, Claude mobile) | `cf5743f9-c83c-4f6c-9afb-0803d5aee698` | `https://claude.ai/api/mcp/auth_callback` |
| Claude Code | `0b968a27-4f37-4972-8d7a-f3c67b365a33` | `http://localhost:8976/callback` |
| Cursor | `cd3b041d-a942-4917-b37f-735744ca4026` | `http://localhost:8787/callback`, `https://www.cursor.com/agents/mcp/oauth/callback` |
| Codex | `6508034a-cdb9-4f23-9263-7bf332096acb` | `http://127.0.0.1:8977/callback/PPpoTd8EYBlz` and `http://localhost:8977/callback/PPpoTd8EYBlz` (the URI Codex derives from the server URL, below, and its `localhost` spare; registered 2026-11-10), plus the earlier `http://127.0.0.1:8977/callback/magicbooklet` and `http://localhost:8977/callback/magicbooklet` |
| ChatGPT | not yet: the owner creates the connector first | per connector, from its management page |

Codex never sends the two `/callback/magicbooklet` URIs to this server. Production's metadata
advertises no `authorization_response_iss_parameter_supported`, so Codex appends its callback ID
for the server, `PPpoTd8EYBlz`, and for a pre-registered client it replaces a configured
`callback_url` that lacks the ID with the default callback (`use_legacy_fallback` in openai/codex,
`codex-rs/rmcp-client/src/perform_oauth_login.rs`). With `callback_port = 8977` it sends
`http://127.0.0.1:8977/callback/PPpoTd8EYBlz` ("Distribution" → "Setup facts per client" →
Codex), which the client has carried since 2026-11-10. `MCP_CLIENT_REDIRECT_URIS.codex` lists it
and the `localhost` spare; re-registering the client from the directory keeps both. The
`/callback/magicbooklet` pair can go whenever the client is next edited.

## Publishing by agents

`publish_post` makes a post from one of three sources. This section is the first, one of the
creator's own succeeded creations; media made elsewhere and text posts are the two sections after
it, and the limits, the cap, the repeat rule and the moderation list below hold for all three. A
creation is published through the same publish service the web's Publish uses
(`showcase-publish-service.ts`), so the post is the one the web would have made: live by default (`visibility: public`), or `private` to keep it on the
creator's profile. With `allow_remixes` (the default) it carries the creation's recipe, the
exact prompt and the saved inputs the creation may share, as the creator page's one-click Publish
does, free unless `resource_price_tokens` prices it ("Text posts, resources and prices"); without
it the media goes alone. The rules the owner set (2026-11-09):

- **Two limits.** Every agent publish passes the web's publish limit (`SHOWCASE_PUBLISH_RATE_LIMIT`,
  20 per 10 minutes per account, which counts attempts as the route does) and, where it makes a
  post public, the agent cap (`AGENT_PUBLISH_RATE_LIMIT` in `backend-rate-limit.ts`, 10 public
  posts per account per UTC day). The cap counts publications, not attempts: the tool counts the
  day's rows recorded `PUBLISHED_PUBLIC` in `agent_tool_calls` before it publishes, so a publish
  the service refuses (a missing handle, a safety refusal, a short recipe title) spends nothing,
  and a private post is not counted. The row is written behind the answer, so two publishes a
  moment apart may both pass: the cap is a guard against a loop, not an exact quota. The tool
  answers `RATE_LIMITED` with `retry_after_seconds` and `reset_at` (the next midnight UTC).
- **Which creation an agent may publish.** The creator's own succeeded creation. One an operator removed
  (`generations.moderation_removed_at`) is answered `NOT_FOUND`, and the publish service itself
  now refuses it on every route, so a removal is never republished; one the creator archived is
  answered `NOT_READY`; another creator's answers `NOT_FOUND` too, disclosing nothing. Without a
  `title` the tool sends the title the web's Publish starts from (the creation's own, else one
  suggested from its prompt), so an agent's post is the web's post.
- **A republish changes nothing but the visibility.** Publishing a creation that already has a
  post returns that post with `already_published: true` and its real `state` (live, private,
  archived, hidden, removed); only an explicit `visibility` that differs changes the post's
  visibility (through the service's own visibility-only path, which keeps the post's text and
  recipe). The post's text is never rewritten by a second publish, and the audit row of an
  unchanged republish names no post, so the moderation list never counts a post the creator
  published by hand as an agent's. The same holds for a text post and a post made from uploads,
  and for all three (since the review of PR #751):
  - A repeat that asks for a visibility change while naming another price, mature mark or remix
    switch than the post has, or a resource for a post that has none, is refused with
    `INVALID_REQUEST` before any limit is spent, and nothing changes. It used to change the
    visibility and drop the rest without a word, so "make it public at 250" put a free resource
    on offer. The agent publishes again without those arguments to change the visibility alone;
    a price, a resource and the mature mark are changed on the website.
  - The cards and listing lines a repeat sends cannot be held against the post (no tool reads
    what a resource holds). They are not applied, and the answer says so.
  - The visibility of a post that is archived, hidden or removed is not changed (`CONFLICT`).
  - A resource the listing rule keeps off offer on a post that went public is reported as
    `resource_status: draft` with the words "not on offer" and what a public listing needs. A
    save that changes the visibility alone does not refuse for it, as a direct public publish
    does.
- **The moderation queue is the same.** An agent's post is a post: reports, the console and the
  CLI treat it as any other. `npm run ops:moderation -- list --source agent` lists the posts agents
  published (newest first, each with its state, from the audit table) and narrows the open post
  reports to them, so an operator can review what agents put on the feed whether or not anyone
  reported it; a take-down is `take-down-post` on its report, as for any post. Its `source` column
  says what each post was made from: `creation` (one of the creator's creations here), `upload`
  (media the agent brought from elsewhere, below) or `text` (a text post). Its `resource` column
  says what the post carries beside itself: `none`, `free` or `paid`.
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

### Media made elsewhere

Since phase 4 (server 1.2.0) an agent can post a picture or a video that was not made here: one
from another tool, or a file of the person's own. Nothing new was built to hold it. The file is
staged in the `uploads` bucket as the web's composer stages one, and the post is made by the
composer's own create (`createOwnerPostForRoute`), so it is a post the web could have made from
the same files: `source_kind` `external`, no creation behind it, no recipe.

**Staging a file** is `upload_input`, which now takes one of three sources:

- `url` and `base64`, as before.
- `upload_id`: a file on the agent's own machine. `request_upload` (`file_name`, `mime_type`,
  `size_bytes`) signs an upload through the web's sign step and answers the signed URL, the
  headers and the one command that sends the file, in its text and as `curl`:

  ```bash
  curl -sS -X PUT -H 'content-type: image/png' -H 'x-upsert: false' -H 'cache-control: max-age=86400' --data-binary @FILE '<upload_url>'
  ```

  `FILE` is the file's path, which the agent fills in, in single quotes
  (`--data-binary @'/path/to/the file.png'`): inside double quotes the shell would expand `$` and
  backticks, and a file's name can hold either. The file's name is never echoed into the command. The three headers are the ones the web's own
  upload sends (`signed-url-upload.ts`): the type finalize holds the stored object to, no
  overwrite, and the cache lifetime a published copy keeps. Storage prints `{"Key": …}` once the
  file is stored. The agent then calls `upload_input` with the `upload_id`, which reads the stored
  object's first 64 bytes through a one-minute signed URL with a `Range` header, applies the
  signature rule the other two sources apply to bytes they hold, and only then finalizes the
  upload for the caller (the stored size must equal `size_bytes` and the stored type the declared
  one). The rule runs first so a file that fails it is never finalized: finalized is the state
  `publish_post` takes a file in, and a failing file whose removal failed must not reach it.

  Only a client with a shell can do this (Claude Code, Codex, Cursor). Claude.ai, Claude Desktop
  and ChatGPT stage by `url`; the tool's description and the setup page say so.

**Limits.** `request_upload` counts against `AGENT_UPLOAD_INPUT_RATE_LIMIT` with `upload_input`
(30 per 10 minutes per account, counted before anything is signed) and holds the declared size to
the URL fetch's caps: 25 MB for a picture, 50 MB for a clip or a track. A post takes 1 to 5
pictures or clips (`MAX_POST_MEDIA_ITEMS`); a track can be staged for a run but not posted, as in
the composer.

**The staging quota an operator should know.** The sign step reserves the bucket's worst case,
250 MB, for every upload it signs, against 1 GB per account (`UPLOAD_BYTE_ADMISSION_POLICY`), so
a creator has at most **four uploads open at once** (`AGENT_OPEN_UPLOADS_MAX`), the web's own
included. A finalized upload gives its place back at once (it is charged its real size). One that
was refused or never finished does not: its signed URL could still be used, so it keeps the 250 MB
until the URL has lapsed (two hours) and the daily `media-upload-reclaim` job has run, which can
be a day. Four refused uploads therefore stop that creator from staging anything, in the composer
too, until the reclaim. What the tools do about it:

- `upload_input` with an `upload_id` first asks whether the upload is still waiting for its file,
  and answers `NOT_READY` without touching it. Finalize would close an empty upload for good.
- A fifth open upload answers `UPLOAD_BYTES_LIMIT` with the number and what frees a place, not a
  failure to retry in a moment.
- The tool's description and the plugin's skill say to send and stage one file at a time, with
  the exact size (`wc -c < FILE`) and the file's own type.

A creator locked out this way is freed by the reclaim. To see it:

```sql
-- One creator's uploads that still hold staging space, newest first.
select id, finalization_status, declared_bytes, reserved_bytes, created_at, expires_at
from public.upload_byte_reservations
where user_id = '<user-id>' and released_at is null
order by created_at desc;
```

| `upload_input` answers | When |
|---|---|
| `NOT_READY` | Nothing is stored at the upload's URL yet. The upload stays open: send the file, ask again. |
| `NOT_FOUND` | No such upload of the caller's (an unknown id and another account's answer alike), or one closed earlier. |
| `UNSUPPORTED_MEDIA` | The stored size or type is not the declared one, or the bytes are not what the type says (a clip's type over a picture's bytes, a picture's type over no picture). The file is removed and the upload closed. |
| `CONFLICT` | The upload was already used by a post or a run. |
| `UPLOAD_BYTES_LIMIT` | The creator's open uploads hold all the staging space an account has. |

**Publishing.** `publish_post` takes one source of three: `generation_id`, `uploads` (1 to 5
items `{ storage_path }`, each the path `upload_input` answered), or neither, which is a text post
(below). Never `generation_id` and `uploads` together. With `uploads`:

- `title` is required, and so is `made_with`: 1 to 5 `{ tool, model? }`, what made the media,
  shown on the post as Made with. It is free text, sent as the composer sends a typed name but
  never with `createTool` or `createModel`: a name the catalog knows is filed under the catalog's
  spelling (`midjourney` → Midjourney), any other stays on the post alone, and an agent never adds
  a row to the catalog every composer picks from. Magicbooklet's own name is refused in every
  spelling the catalog reads as the app (`Magic Booklet`, `magicbooklet`, `magic-booklet`,
  `Emptybooklet`): media made here is published with `generation_id`, which names its model
  itself. `made_with` with `generation_id` is refused too, and so is `allow_remixes` with
  `uploads` (an upload has no recipe).
- Only a file staged through `upload_input` and not yet used is published: the tool reads each
  path's reservation (`readAgentStagedUploads`) and refuses one that was sent but never staged
  (`NOT_READY`), one already used (`CONFLICT`) and one that lapsed (`NOT_FOUND`), so nothing
  reaches a post without the signature rule. A path that is not in the caller's own staging
  folder is left to the composer service, whose ownership rule refuses it ("Uploaded media must
  belong to the authenticated user.").
- The same two limits as a creation (the web's publish limit, and the agent cap for a public
  post), then the composer's own `POST_MUTATION_RATE_LIMIT`, title and text rules, the public
  profile check, the consumption of each staged file and the media processing. The composer's
  refusals reach the agent under stable codes with the composer's message and never its
  follow-up link.
- **A repeat never makes a second post.** The post's id is derived from the creator and the
  ordered staged paths (`agentUploadPostId`: a UUID from a SHA-256, marked version 4 as every
  other post id is. It was version 8 until the review of PR #751: account deletion reads each
  post's storage paths with a pattern that takes versions 1 to 5, after the account is marked as
  deleting, so a creator with one such post could never have been erased). A publish repeated
  after a lost answer reads that id first and answers the post with `already_published: true`;
  only an explicit `visibility` that differs changes it, through the composer's save
  (`updateOwnerPostForRoute` with the visibility alone, since the creation path's republish needs
  a creation). After a failure that is not the caller's, the tool says to publish again with the
  same uploads: it answers the post where one was saved, and says so where the files were spent
  and must be staged again.
- The post's id is its only handle: `list_creations` lists creations, and the answer says to keep
  the `post_id`. `get_post` reads such a post (`generation_id` null) and `delete_post` deletes it,
  with its media, since no creation holds a copy.

**How it is recorded.** Under `tool = 'publish_post'`, so the daily cap, the moderation list and
the partial index apply unchanged: `PUBLISHED_PUBLIC` or `PUBLISHED_PRIVATE` with `post_id` set
and `generation_id` null. An unchanged repeat records `ALREADY_PUBLISHED` and, unlike a
creation's, still names the post: only an agent's publish makes a post under a derived id, and the
call that made it may have lost its row to the same timeout that made the agent repeat it. The
moderation list's `source` column reads `upload` for these posts (`text` for a text post, which is
recorded the same way).

```sql
-- Posts agents made from uploads this week, with what each says made it.
select c.created_at, c.client_id, c.user_id, c.post_id, p.visibility, p.review_status, p.title, p.source_tool
from public.agent_tool_calls c
left join public.posts p on p.id = c.post_id
where c.tool = 'publish_post' and c.ok and c.post_id is not null and c.generation_id is null
  and c.created_at > now() - interval '7 days'
order by c.created_at desc;
```

**Proven before release (2026-11-10), on a throwaway local stack** (a scratchpad copy of
`supabase/` with its own `project_id` on ports 563xx; never production):

- (The ids in these runs were version 8 and are version 4 since the review; both runs were
  repeated after the review's fixes: "After the review", below.)
- The upload protocol against real Storage: for a signed upload URL in `uploads`, the command
  above stored a 307,678-byte PNG, a 349,449-byte MP4 and a 12.6 MB PNG (one PUT, above the 6 MB
  at which the web switches to resumable chunks; its path held a space) with the declared size,
  the declared type and `cache-control: max-age=86400`; the `Range` read answered 206 with the
  file's first 64 bytes; a second PUT to the same URL answered 409 `Duplicate`; a `text/html`
  type answered 415 and stored nothing.
- The tools with the real services behind them: `request_upload`, the command, `upload_input`
  (reservation `finalized`); a picture sent under a clip's type and a wrong `size_bytes` refused
  and removed (reservation `deleted`); an early `upload_input` answered `NOT_READY` and the same
  upload then took its file; a private post of a picture and a clip (`generation_id` null,
  `source_kind` `external`, Made with `Midjourney` / `V7` from the catalog and `My Own Renderer`
  as given, the catalog's row count unchanged, staged files gone, reservations `consumed`); a
  repeat answered `already_published`; `visibility: public` made the one post public; a post
  public at once; the audit rows written to the real table, the moderation list reading `upload`
  and the cap counting one; `get_post` and `delete_post`; and the fifth open upload answering
  `UPLOAD_BYTES_LIMIT`.

After a release that carries a change here, check it on production with a private post from
Claude Code: stage a small picture with `request_upload` and the command, `upload_input`,
`publish_post` with `uploads`, `visibility: private`, a real title and `made_with`; repeat the
same publish (`already_published`); `get_post`; then `delete_post`.

### Text posts, resources and prices

Since 2026-11-10 (the owner's decisions of that day, in the same server 1.2.0) `publish_post` has
a third source, and a post may carry something to unlock. It is how an agent shares a prompt, a
guide or a skill. The product's own facts are `docs/post-resource-bundle-v1.md` (tokens, the
price steps, one bundle per post, creators keep 85%, a sold post cannot be hard-deleted); nothing
here changes them.

**A text post.** With neither `generation_id` nor `uploads`, `title` and `body` publish as the
composer's own text post, through the same `createOwnerPostForRoute` an upload post takes:
`postFormat` and `category` both `text`, `source_kind` `manual`, no creation behind it. The
limits are the composer's and are in the tool's description: a title of 100 characters, a body of
2,000, a description of 1,000. `made_with` is optional and held to the upload rules where given
(the composer sends it for a text post too); `allow_remixes` and `category` are refused. A public
text post counts against the agent's daily cap like any other.

The post's id is derived from the creator, the title and the body, read as the composer reads
them (trimmed, line ends as `\n`): `agentTextPostId`. So a repeat answers the same post with
`already_published: true`, and a text post deleted since is made again by the same call.

**Resources.** `resources` is 1 to 10 cards `{ type, title, description?, text?, url? }` on a
text post or an upload post:

| `type` | Carries | Stored as |
|---|---|---|
| `prompt` | `text`, a prompt ready to paste | a `prompt` item |
| `guide` | `text`, instructions or notes, such as a skill | a `note` item |
| `external_link` | `url`, https only | an `external_link` item |

The cards are serialized by the composer's own `buildResourceCardBundleInput`
(`post-composer-resource-cards.ts`), from cards the composer's factory makes under ids the tool
gives (`agent-resource-1`, …, so the same cards make the same bundle), with `allowRemix: false`,
and ride as the form's `resourceBundle`. So the bundle is the one the web or the app composer
would send for the same cards, and `validatePostResourceBundleInput`, the listing rule and the
safety check decide it as they decide any. Text and links only: no file is attached.

- The bounds. The validator's: a card title of 80 characters, a card description of 120, a
  summary and a preview of 180 each. The tool's own, where the composer and its validator set
  none: 10 cards, and 50,000 characters of text a card
  (`AGENT_RESOURCE_CARDS_MAX`, `AGENT_RESOURCE_CARD_TEXT_MAX_LENGTH`). A card that gives both
  `text` and `url`, or the wrong one for its type, is refused rather than having half of it
  dropped, and a link that is not https is refused (the composer takes http too).
- What everyone sees before unlocking: each card's title, `resource_summary` and
  `resource_preview`. Left out, the summary is the preview where one was given, else made from
  the card titles ("3 reusable resources"), and the preview is "Includes A, B, and C.". What only
  an unlock shows: a card's description, its text and its link (the locked preview carries card
  titles alone, `sanitizePostResourceBundleLockedPreview`). The tool's description says so, so an
  agent keeps what is sold out of the titles and puts what sells the resource in the preview.
- `resources` with `generation_id` is refused: a creation's resource is its own recipe, which the
  server builds from the run.

**A price.** `resource_price_tokens` is a whole number of tokens, 10 or more in steps of 10,
where 100 tokens are $1.00; left out or 0, the resource is free. The description tells the agent:
"State the price to the person and get their yes before publishing a paid resource; never choose
a price yourself." What an operator should know:

- It prices the cards of a text or upload post, or with `generation_id` the creation's recipe.
  The paid recipe is the request the web's Publish sends for one (`buildAutoResourceBundle`:
  `accessMode: 'paid'`, the token count in `priceUsdCents`), so the publish service's own rules
  hold it: its validator, the listing rule, the remix terms (a remix of a paid recipe must be
  paid, of a free one free; `REMIX_RECIPE_MUST_BE_PAID` and `REMIX_RECIPE_STAYS_FREE` reach the
  agent with the argument that meets them), and the rule that keeps a paid prompt out of the
  post's title and text. With no title given, the title the tool suggests is not cut from the
  prompt of a recipe that is sold.
- The tool computes nothing. The number is refused or passed as given: the schema and the handler
  both refuse one below 10, off the step, a fraction or a negative before anything is read or any
  limit is spent, and the services' validators stay the authority (the validator rounds a
  fraction, so the tool is the one that refuses it).
- A price with nothing to carry it is refused, not dropped: a text or upload post without
  `resources`, a creation published with `allow_remixes: false`, a creation with no prompt. So
  are `resource_summary` and `resource_preview` in the same cases.
- A resource is on sale only while its post is public: on a private post the service holds it as
  a `draft`, and the database's exposure trigger puts it on offer when the post goes public,
  through this tool or on the site. Buyers pay the creator as on the site.
- After publishing, a price or a resource is changed on the website, not by an agent. A repeat of
  the same creation, uploads or text answers the existing post unchanged, its resource and price
  included, whatever the repeat names, and says where they are changed.

**Arguments are strict.** `publish_post`'s schema refuses a key it does not know, at every level.
With both source keys optional, a misspelled one (`generationId`) would otherwise be dropped and
leave a title and a body to publish as a public text post.

**While a publish is running.** A post of several clips can take longer than an MCP client waits
(about 60 seconds), so the route's own limit is the composer route's 300 seconds
(`MCP_ROUTE_MAX_DURATION_SECONDS`, `src/app/api/mcp/route.ts`): the publish finishes, and the
agent's repeat finds it. What a repeat is told meanwhile:

| The repeat finds | It is answered |
|---|---|
| No post yet, and a file the first call has claimed (`consuming`) | `NOT_READY`: being published by another call; call again. Never "stage the file again", which would make a second post under new paths. |
| The post's row, holding fewer files than the repeat names, made less than 300 seconds ago | `NOT_READY`: still being saved; call again. |
| The same, older | `CONFLICT`: left unfinished by a publish that failed midway. Delete it with `delete_post` and publish again, or finish it on the website. Its visibility is not changed. |
| The whole post | `already_published`. |

Two identical text publishes sent at the same moment are not told apart (a text post has no file
to claim): both read no post, the create is an upsert under the one derived id, so one post
results, the later call's arguments stand, and both are recorded. An agent has no reason to send
both; the cap counts two.

**What an answer says of a resource.** Three fields, on every `publish_post` answer and on
`get_post`: `resource_access` (`none`, `free`, `paid`), `resource_price_tokens` and
`resource_status` (`draft`, `published`, or null for none). `get_post` reads them from four
columns of the post's row in `post_resource_bundles` (`access_mode`, `price_usd_cents`, `status`,
`retired_at`; `agent-post-read.ts`). No agent tool reads what a resource holds, and the bundle
read behind the paywall (`hydrateBundleRows` in `post-resource-bundles-server.ts`) is not called
or changed. Another creator's agent is told of a resource only while it is on offer; a draft is
its owner's to know, and a resource its creator removed while people held it (a retired row) is
none.

**Refusals** carry the service's own message under `INVALID_REQUEST`, with its field under the
tool's argument name (`resourcePreview` → `resource_preview`, `resourceCards` → `resources`).
The ones an operator will see asked about:

| The service says | Why |
|---|---|
| "Paid recipes must cost at least 10 credits and use 10-credit increments." | A price the tool should already have refused; the validator's own rule. |
| "Improve this recipe before publishing: Add a useful preview or summary …" | A public post's resource needs a preview or summary of 18 characters or more that is no placeholder. A one-card resource titled "Tip" derives "Includes Tip.", which is too short: the agent gives `resource_preview`. |
| "A recipe needs a title of at least 3 characters." | The post's title, for a post with a resource. |
| "Complete your profile before publishing publicly: choose a custom handle and add your display name." | The creator has no handle and display name yet. The web answers with a link to the profile; the tool answers in words ("The person sets their handle and display name on the website, then you publish again."), never the link. |

**How it is recorded.** As an upload post is: under `tool = 'publish_post'`, `PUBLISHED_PUBLIC` or
`PUBLISHED_PRIVATE` with `post_id` set and `generation_id` null, and an unchanged repeat names the
post. A row holds no price and nothing of a resource. The moderation list tells a text post from
an upload post by the post's own format, so a deleted post with no creation behind it reads
"upload or text", and reads each post's `resource` in one query for the page. The list reads the
unchanged repeats apart from the publications (two reads of `agent_tool_calls`): a repeat spends
no limit, and a loop of them would otherwise fill the page and hide every other agent's posts.

**Creators who connected before this release** approved the consent screen's earlier line, which
named neither media from elsewhere nor a price. Re-authorizing takes the already-approved
redirect, so they do not see the new one. Whether to revoke those grants so each is asked again
(Revoking a client, or one creator's grant) is the owner's decision; nothing here does it.

```sql
-- Posts agents published that carry a resource on sale, newest first.
select c.created_at, c.client_id, c.user_id, c.post_id, p.post_format, p.visibility, p.title,
       b.access_mode, b.price_usd_cents as price_tokens, b.status, b.sales_count
from public.agent_tool_calls c
join public.posts p on p.id = c.post_id
join public.post_resource_bundles b on b.post_id = p.id and b.retired_at is null
where c.tool = 'publish_post' and c.ok and c.code in ('PUBLISHED_PUBLIC', 'PUBLISHED_PRIVATE')
  and b.access_mode = 'paid'
order by c.created_at desc;
```

**Proven before release (2026-11-10), on a throwaway local stack** (the same scratchpad copy on
ports 563xx; never production), the tools with the real services behind them:

- A private text post with a free guide card: `post_format` and `category` `text`, `source_kind`
  `manual`, the bundle `free` and `draft` with one `note` item under the tool's card id. A repeat
  that named a price answered `already_published` and changed nothing; another creator's
  `get_post` answered `NOT_FOUND`; `visibility: public` made the one post public and the bundle
  `published`.
- A text post public at once with a prompt and a link at 250 tokens, with Made with: the bundle
  `paid`, 250, `published`, the person's summary and preview stored. `get_post` by its owner and
  by another creator answered `paid`, 250, `published`, and no answer held the cards' text or the
  link.
- A text post at 100 tokens saved private: `draft`; made public with a repeat that named 990: on
  offer at 100.
- The refusals: a price of 5, 255, 10.5 and -10, a price with no resource, a prompt card with no
  text, an http link, a title with no body, a thin preview on a public post, and a creator with no
  handle (in words, no link). None made a post.
- An upload post with a prompt card at 50 tokens: one media row, the bundle `paid` and
  `published`.
- A creation's recipe at 250 tokens, on a seeded creation: `draft` on the private post, on offer
  at 250 once public, and the prompt in no answer and not in the post's public row.
- The audit rows written to the real table, the cap counting five public publications, and the
  moderation list reading `text` / `free`, `text` / `paid`, `upload` / `paid` and `creation` /
  `paid`. A deleted text post was made again by the same title and body.

**After the review (2026-11-10).** The fresh-context review of PR #751 found fifteen gaps (the
plan lists them). Both runs above were repeated on the same kind of stack after the fixes, with
the real services: the upload run whole; a repeat that named another price with a visibility
change refused (`INVALID_REQUEST`), on a text post and on a creation's post, with the post still
private and its resource and price untouched, and the same call without the price then put the
resource on offer at its own; the schema refusing a misspelled `generationId`; the derived ids
version 4; and the moderation list, asked for ten posts after sixty unchanged repeats of one of
them had been recorded, still listing all five.

After a release that carries a change here, check it on production from Claude Code without
putting anything on sale: `publish_post` with a title, a body, one `guide` card, a preview and
`visibility: private` (answer: `source: text`, `resource_access: free`, `resource_status: draft`);
repeat it (`already_published`); `get_post`; then `delete_post`. A price is checked the same way
on a private post, where the resource stays a draft, and only with a number the owner gave.

### The audit table

Every tool call writes one row of `public.agent_tool_calls` behind its answer
(`src/lib/agent-tool-calls.ts`, migration `20261109183611_agent_tool_calls.sql`): `user_id`,
`client_id` (the OAuth client), `tool`, `ok`, `code` (the tool's error code when it failed; for a
successful `publish_post`, which answer it was: `PUBLISHED_PUBLIC`, `PUBLISHED_PRIVATE`,
`MADE_PRIVATE` or `ALREADY_PUBLISHED`), `generation_id` and `post_id` where the call was about
one (an unchanged republish of a creation names no post; a publish of uploads or of a text post
names no creation, and names its post on a repeat too: "Media made elsewhere"), `cost_credits`
where the answer
charged the creator, `created_at`. Prompts and results are never written. The owner may read their own rows; the
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
mutation's 60 for `delete_post` and for a text post or a post made from uploads (its create, and
a change of its visibility), and `upload_input`'s own 30 per 10 minutes, which `request_upload`
shares, before
the upload sign, finalize and read-url limits. An agent that hits them is answered `RATE_LIMITED`
with `retry_after_seconds`. The staging quota is not one of them: it answers `UPLOAD_BYTES_LIMIT`
("Media made elsewhere").

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
3. The `WWW-Authenticate` challenge reaches Claude Code through Vercel: the setup page's
   `claude mcp add` (user scope, the Claude Code client, `--callback-port 8976`), then `/mcp` (or `claude mcp login magicbooklet` from a terminal) opens the browser on
   `/oauth/consent`, Allow lands on Claude Code's own callback page, and `claude mcp get
   magicbooklet` reports Connected. The route's 401 carries the challenge; the proxy's own 401
   does not, which is why `/api/mcp` owns its admission.
4. `list_models` through Claude Code answers the production catalog's revision, and a
   `get_generation` with `wait_seconds` 45 on a running creation answers rather than timing
   out: the wait, the admission round trips and the final read must all fit under the route's
   60 seconds and the client's own request timeout (the tools suggest 30 for that reason).
5. One real Codex sign-in, since Codex's flags and keys here come from its documentation and
   source, not a run: the setup page's `codex mcp add` with the Codex client, `callback_port =
   8977` in `~/.codex/config.toml`, then `codex mcp login magicbooklet` opens `/oauth/consent`
   with `redirect_uri=http://127.0.0.1:8977/callback/PPpoTd8EYBlz`, Allow completes the login,
   and `list_models` answers in Codex.

Verified on production on 2026-11-09, with the OAuth server on (issuer
`https://ildfmhozpibwiopeavfg.supabase.co/auth/v1`):

- Check 1: the RFC 8414 path-insertion form `/.well-known/oauth-authorization-server/auth/v1`,
  `/auth/v1/.well-known/openid-configuration` and `/auth/v1/.well-known/oauth-authorization-server`
  answer 200 with that issuer. `/.well-known/openid-configuration/auth/v1` answers 401 through
  production Kong, which does not matter: Claude Code tries it only after the path-insertion form,
  which works.
- Check 2: `/auth/v1/oauth/authorize` and `/auth/v1/oauth/token` answer without an `apikey`
  header (400 for a wrong redirect URI or client).
- The metadata has no `registration_endpoint` (registration off) and no
  `authorization_response_iss_parameter_supported`, which is why Codex's redirect carries its
  callback ID ("Registered clients", above).

Check 3 and the first half of check 4, on 2026-11-09 with the Claude Code client on the dev Mac
(the release of `e8b4a1766`, then of `48af4d7f1` at 20:24 UTC):

- Check 3: `claude mcp add` at user scope with `--callback-port 8976`, then `claude mcp login
  magicbooklet` (it needs a terminal, and gives up after about five minutes without an answer)
  opened `/oauth/consent`, which sent a signed-out browser to `/login` and back; Allow landed on
  Claude Code's callback page and `claude mcp get magicbooklet` reported Connected. A second
  authorize for the same account and client came back approved with no click.
- Check 4: `list_models` and `quote_generation` answered from a Claude Code session (catalog
  revision `kie-models-20261105`). The 45-second wait on a running creation was not exercised:
  none was running, and nothing was started for the check.
- The other tools, with a token from the same client: `tools/list` names eleven tools;
  `list_creations`, `get_generation` with `include_preview` (one image block), `get_post`, and
  `publish_post` on a creation already posted (`already_published`, nothing changed) answered
  in about a second; `delete_post` of an unknown id answered `NOT_FOUND`; `upload_input` refused
  an `http` URL (`INVALID_URL`) and `localhost` and `169.254.169.254` (`PRIVATE_ADDRESS`), and
  staged a small picture by base64 and one by a public `https` URL; each call left its row in
  `agent_tool_calls`. Connected apps on `/profile/edit` listed Claude Code with Disconnect.
  `create_media` and a first new post were left for the owner: both act on the account.

Check 5 is still open, and so is check 4's 45-second wait on a running creation.

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
- **Claude Code**: `claude mcp add --transport http --scope user --client-id <id> --callback-port 8976 magicbooklet https://magicbooklet.com/api/mcp`,
  then `/mcp` → Authenticate (or the plugin, below; one or the other, not both). `--scope user`
  matters: the default scope, `local`, ties the server to the folder the command ran in, so it
  would be missing from every other project. The redirect is `http://localhost:8976/callback`;
  the port must be free while the person signs in.
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
the Claude Code client and port 8976, and four skills: `create-ugc-ad` (models, quote, the
person's yes, `create_media` with `expected_cost_credits` and one `idempotency_key`, the wait,
an offer to publish), `publish-creation` (a finished creation, a title that is no placeholder,
`publish_post`) and, since plugin 1.1.0, `post-outside-media` (stage each file, by link through
`upload_input` or from the machine through `request_upload` and its command, one file at a time;
then `publish_post` with `uploads`, a real title and `made_with`, after asking who can see it)
and `share-a-skill` (a text post whose `guide` card holds a skill's instructions and whose body
introduces it: the skill is read for anything private before it is shared, it goes free unless
the person asks to sell it, and then only at a price they named and said yes to). A creator
installs it with:

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
  `enhance_prompt`, `publish_post`, `delete_post`, `upload_input` and `request_upload` always
  reach the person's permission prompt, which the manifest test holds.
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

Publishing needs the route live in production, which it is since 2026-11-09, and what the
entry says must already be true there: its description says agents post creations, the registry
refuses a second publish of the same version, and a correction later costs a version bump of
`server.json` and `MCP_SERVER_VERSION` together. The first publish checked that `publish_post`,
`get_post`, `delete_post`, `upload_input` and Connected apps answered in production first; a
later one checks whatever its new description claims.

1. Install the publisher: `brew install mcp-publisher` (or the release binary from
   `github.com/modelcontextprotocol/registry/releases`), and check `mcp-publisher --help`.
2. Fetch the proof as the registry does, from Google Cloud with no redirects and a 10-second
   timeout:

   ```bash
   curl -sS -o - -w '\n%{http_code}\n' -H 'Accept: text/plain' -A 'mcp-registry/1.0' https://magicbooklet.com/.well-known/mcp-registry-auth
   ```

   It must answer the record and `200`. A Vercel firewall or bot rule that challenges
   non-browser clients fails the login with `token exchange failed with status 401`. Then check
   that the static build kept the route's headers:

   ```bash
   curl -sSI https://magicbooklet.com/.well-known/mcp-registry-auth
   ```

   `content-type: text/plain; charset=utf-8` and `cache-control: public, max-age=300, s-maxage=300`
   (the five-minute cache that lets a rotated key reach the next login quickly).
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

Published first on 2026-11-09 at 20:28 UTC: `com.magicbooklet/mcp` 1.1.0, `status: active` and
`isLatest` in the registry's answer, by the HTTP method above; `mcp-publisher logout` clears the
saved login afterwards.

A later publish (a new description, say) needs a new `version`: the registry refuses one it
already has. `server.json`'s version and the server's own `MCP_SERVER_VERSION` move together;
`mcp-registry.test.ts` holds them equal.

Phase 4 moved both to 1.2.0 (twelve tools: `request_upload` added, `publish_post` taking
`uploads`, text posts, `resources` and `resource_price_tokens`); the description is unchanged,
and still true. The registry keeps 1.1.0 until 1.2.0 is published by the steps above, after the
release that carries it is live and the production checks under "Media made elsewhere" and "Text
posts, resources and prices" have passed.

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
