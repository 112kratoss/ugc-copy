# How competitors expose themselves to AI agents (MCP, connectors, plugins)

Research date: 2026-11-09. Three parallel web-research passes (generation platforms, direct UGC and ad-creative competitors, distribution mechanics), with the one blocking finding re-checked first-hand against Anthropic's pages. Nothing here is implemented; this is the input to deciding Magicbooklet's own agent surface. Items marked *unverified* came from third-party pages only.

## Summary

1. **An official remote MCP server is now table stakes.** About 17 of the ~30 competitors checked run one (HeyGen, Higgsfield, Runway, Krea, Hedra, Synthesia, InVideo, Creatify, Arcads, Topview, OpusClip, Canva, Adobe, ElevenLabs, fal, Replicate, BFL). Almost all shipped between mid-2025 and late 2026. Local, API-key servers are being retired (ElevenLabs and Runway archived theirs).
2. **The default shape is identical across the market:** Streamable HTTP endpoint, OAuth sign-in with the product account (no API key), billed from the user's existing plan credits, tools of the form `list_models → get_model_schema / estimate → generate → get_job`, output saved to the user's private library and returned as a link, shipped as a Claude custom connector plus a ChatGPT app plus Claude Code / Cursor / Codex instructions, with packaged "skills" or workflows on top.
3. **Nobody lets an agent publish to the vendor's own public feed or community.** Every creation tool stops at the private library or an export. Synthesia goes furthest with a private-by-default share link that can be unpublished. Social cross-posting lives in separate products (OpusClip, Buffer, Hootsuite, agent-media). Publishing to the Magicbooklet showcase would be new in this market.
4. **Anthropic's connectors directory will not list us as we stand.** Its pre-submission checklist rejects connectors that "Generate images, video, or audio through AI models", and the Software Directory Policy §4B excludes image, video and audio generation "unless otherwise expressly permitted by us in writing". Custom connectors (any user adds the URL) and our own Claude Code plugin marketplace are unaffected. ChatGPT's guidelines carry no such media ban but forbid selling or upselling credits inside the app.
5. **Kie.ai, our provider, has no first-party MCP;** only community key-based wrappers. Nothing Kie-backed has a consumer-grade connector today.

## Direct UGC and ad-creative competitors

| Competitor | Surface | Create | Publish | Auth | Gating |
|---|---|---|---|---|---|
| Arcads | MCP `mcp.arcads.ai` (help article 2026-06-26) + skills plugin (`/spy-competitor-ads`, `/clone-hook`, `/clone-static-ad`) | video ads | no | account | active subscription with credits |
| MakeUGC | MCP `mcp.makeugc.ai` + Platform API | yes | no | API key | API plan ~$99/mo (*unverified*) |
| Creatify | "Ad Agent MCP"; ChatGPT, Claude, Codex, Cursor, VS Code, Grok | yes | no (separate Ad Launcher product) | OAuth, no key | all plans incl. Free; spends credits |
| Captions / Mirage | docs-search MCP only | no | no | key | – |
| Icon.com | third-party listing only (*unverified*) | ? | ? | ? | ? |
| AdCreative.ai, Pencil, Predis | none found | – | – | – | – |
| Foreplay | MCP, ad-library research only | no | no | OAuth | plan |
| Synthesia | MCP `mcp.synthesia.io/mcp`; ChatGPT + Claude incl. mobile | yes | **share link, private until published, unpublishable** | OAuth | plan credits; Enterprise SSO/SCIM/per-user caps |
| HeyGen | MCP `mcp.heygen.com/mcp/v1/`; ChatGPT app, Claude, Codex, Cursor, Gemini CLI | ~89–100 tools mirroring REST | no; `get_video` returns a URL | OAuth + domain allowlist | all plans, some tools paid |
| Hedra | MCP `mcp.hedra.com` + CLI (2026-08-31) | image, video, speech, music, SFX | no (library) | browser sign-in or scoped MCP key | subscription or USD wallet |
| Higgsfield | MCP `mcp.higgsfield.ai/mcp` (live by 2026-04-28); ChatGPT plugin, Claude custom connector, Cursor, CLI + skills | 35+ models, 41 workflows (`/ugc-flow`, Ad Recreator, Hook Multiplier) | no (Assets, tagged with MCP source) | account | paid only; "unlimited" tier excluded over MCP |
| Topview | MCP + skills (TikTok Product Ad, Try-On Ad) | yes | no | account | Plus+; Unlimited excluded |
| Runway | consumer MCP (ChatGPT directory, Claude, Cursor, Grok, Replit) + dev plugin with 7 skills | yes | no (library) | account | plan credits |
| Krea | MCP `api.krea.ai/mcp` | generic `generate` + node apps | no | OAuth w/ workspace picker, or token | workspace compute units |
| Pika | MCP `mcp.pika.me/api/mcp` (2026-05-28) + Claude skills (`/pika:ugc-ads`) | one agent persona routing 14+ models | no | OAuth | token wallet |
| Canva | MCP `mcp.canva.com/mcp` (2025-06), ChatGPT app (2025-10), Anthropic directory, official registry | `generate-design` → candidates → editable design | `export-design` only | OAuth | Pro+ |
| Adobe | Claude connector (2026-04-28, 50+ tools), ChatGPT apps (2025-12-10) | editing, Express templates; Firefly gen disputed | hand-off to app | Adobe ID | plan |
| InVideo, VEED | MCP; returns editor link / MP4 URL (VEED points users to Make.com for posting) | yes | no | OAuth / account | plan / credits |
| OpusClip | MCP, 27 tools | clips, edit, export | **schedule to connected social accounts** | OAuth | render needs paid |
| Buffer, Hootsuite (Perch) | MCP for posting queues; human review stressed | no | **yes, to social networks** | OAuth / workspace | plan |
| agent-media (Postiz team) | MCP + Claude plugin | `make_ugc` | `social_publish` to TikTok/IG/X | API key | – |

Sora, Google Flow/Veo, Luma, Midjourney, Ideogram, Stability, Kie: no first-party MCP; API or community wrappers only.

## Design patterns worth copying (from the best-built servers)

- **Catalog-driven generic generate** (fal, Krea, BFL): `list_models / search_models → get_model_schema → generate(model_id, input)`. Our `/api/model-catalog/v1` descriptors are already that schema payload. The two failure modes are Leonardo (one hard-coded `generate-image`) and HeyGen (89 tools mirroring REST).
- **A free quote tool** (Krea `preflight` returns `{compute_units, is_estimated, available_compute_units, affordable}`; fal `get_pricing`; Higgsfield's blog says the agent shows the cost and waits for approval). Our quote route already exists.
- **Start then poll** (fal blocks ≤45 s then returns a request id with `poll_after_seconds`; BFL returns a pending `request_id` at once; Krea is job-first by default with sync opt-in). Both fal and ElevenLabs had to document "don't resubmit to check progress, each submit bills".
- **Idempotency key** on generation (Higgsfield *unverified*, HeyGen replays within 24 h unbilled) so a timed-out retry does not double-charge. Our `generation-start-idempotency.ts` already covers this.
- **Cancel refunds only while queued** (Higgsfield); failed or NSFW-rejected jobs are not charged.
- **Durable product link plus a short-lived media URL** (ElevenLabs "Flow", Hedra and Runway library, Higgsfield Assets). Raw provider URLs expire (ElevenLabs ~2 h, Runway 24 h, HeyGen "poll to refresh"). Our outputs are already in Supabase Storage.
- **Workspace or wallet picker at consent** (Krea, BFL, ElevenLabs). Krea's split between OAuth workspace units and a separate API balance is confusing; keep one balance.
- **Cost warnings in paid tools' descriptions** (ElevenLabs' old server: "only use when explicitly requested") plus `destructiveHint: true` so clients prompt.
- **Skills shipped alongside** (BFL `list_skills` + MCP prompts; Runway 7 skills; Pika `/pika:ugc-ads`; Hedra CLI writes SKILL.md; Higgsfield 41 workflows). Templates and bundles are the natural source.
- **MCP Apps widget** (Krea's self-polling widget with cancel/retry and before/after slider; ElevenLabs and Canva inline in ChatGPT) for progress, preview and a Publish button.
- **Agent-source tag** on generations made over MCP (Higgsfield), useful for moderation and metrics.

## Distribution mechanics (current as of 2026-11)

**MCP spec** revision 2026-07-28: stateless (no `initialize`, no session id), Streamable HTTP, Tasks moved to an extension (`resultType: "task"` with `taskId`, `pollIntervalMs`), DCR deprecated in favour of Client ID Metadata Documents (CIMD), `iss` validation, tool annotations `title / readOnlyHint / destructiveHint / idempotentHint / openWorldHint`.

**Client limits:** Claude.ai and Desktop tool timeout 240 s per call, ~150k-char result cap; Claude Code backgrounds a call after 2 min and caps output at 25k tokens, shows PNG/JPEG/GIF/WebP results inline; Codex `tool_timeout_sec` default 60; Cursor attaches base64 images. OAuth discovery, registration and token endpoints must answer within 10 s. Never block on a Kie job.

| Channel | Review | Requirements | Notes |
|---|---|---|---|
| Claude custom connector (URL) | none | HTTPS, OAuth, 401 with `WWW-Authenticate: Bearer resource_metadata=…` | every plan incl. Free (one connector); Team/Enterprise owner adds it |
| Claude Code `claude mcp add --transport http` | none | same | loopback redirect on an ephemeral port |
| Own Claude Code plugin marketplace | none | public repo with `.claude-plugin/marketplace.json`, `.mcp.json` (`"type":"http"` required), `skills/*/SKILL.md` | install: `/plugin install name --marketplace owner/repo` |
| Anthropic connectors directory | automated scan → Community; maybe Verified | paid plan to submit; every tool has `title` + `readOnlyHint`/`destructiveHint`; read/write split; test account fully populated; docs, privacy, support, icon | **excluded for AI media generation** unless written exception (mcp-review@anthropic.com) |
| ChatGPT directory ("plugins") | manual, email feedback, no SLA | org verification; 5 positive + 3 negative test cases, video, demo account w/o 2FA; explicit `readOnlyHint`/`destructiveHint`/`openWorldHint` on every tool | **no selling or upselling credits in-app**; no media-generation ban found |
| ChatGPT developer mode (unlisted) | none | – | Business/Enterprise/Edu confirmed; Plus/Pro *unverified* |
| Codex | none | `codex mcp add <name> --url …` then `codex mcp login <name>` | OAuth supported |
| Cursor | none for deeplink; Marketplace requires open source + manual review | `cursor://anysphere.cursor-deeplink/mcp/install?name=…&config=base64` or `.cursor/mcp.json` | – |
| Official MCP registry | none (preview, API v0.1) | `server.json` named `com.magicbooklet/mcp`; DNS TXT or `/.well-known/mcp-registry-auth` proof; `mcp-publisher publish` | consumed by aggregators, not end users |

## Supabase Auth as the authorization server

Public beta on all plans; `[auth.oauth_server]` is currently `enabled = false` in `supabase/config.toml`. We host the consent page at Site URL + authorization path (e.g. `magicbooklet.com/oauth/consent`) using `getAuthorizationDetails` / `approveAuthorization` / `denyAuthorization`, and need a revoke-access UI. Issuer `https://<ref>.supabase.co/auth/v1`; RFC 8414 metadata at `/.well-known/oauth-authorization-server/auth/v1`.

Known gaps to design around:
- Tokens are ordinary Supabase JWTs with a `client_id` claim and **no `scope` claim**; `aud` is settable only via a Custom Access Token Hook. Validate on `client_id`, or set `aud` to the MCP URL with a hook (ChatGPT expects the resource in `aud`).
- HS256 by default; JWKS validation and OIDC need ES256/RS256 signing keys.
- CIMD and RFC 8707 `resource` are not documented, so Claude and ChatGPT will fall back to DCR (one client per connection; Anthropic warns about the volume).
- Redirect URIs must match exactly; Claude Code's loopback uses a random port, so test it (`claude mcp add --callback-port` pins one).
- The consent page must refuse `is_anonymous` sessions, or guests could authorise agents.

Server side: `mcp-handler` 2.3.1 (peer `next >=13`, `@modelcontextprotocol/server ^2`, zod 4) with `withMcpAuth` on `app/api/mcp/route.ts` and `protectedResourceHandler` on `app/.well-known/oauth-protected-resource/route.ts`; both paths plus `/oauth/consent` need entries in `route-identity-policy.ts` and `src/proxy.ts`, returning 401 (not a redirect) without a token. Set the route's `maxDuration` ourselves (2.x dropped the option).

## What this means for Magicbooklet

- Match the default shape so agents and users find nothing surprising: OAuth with the Magicbooklet account, plan credits, `list_models` / `quote` / `create_media` / `get_generation` / `upload_input`, output as a permanent creation URL plus a signed media URL.
- Differentiate with the showcase: `publish_post` (draft → preview link → explicit publish, with unpublish), later `search_showcase`, `get_recipe`, `remix`. No competitor offers any of these. Model the publish flow on Synthesia and keep the title, recipe and remix-credit rules server-side as they already are.
- Expect agent-driven publishing to invite volume spam: per-account rate limits, the moderation queue, a daily publish cap, and an agent-source tag on generations and posts.
- Keep credit purchase on the web (required by ChatGPT's rules, and it keeps the "no money transfer" attestation clean everywhere).
- Distribution without the Anthropic directory: custom connector + our own plugin marketplace with a UGC skill + Codex/Cursor instructions + MCP registry entry, and apply for the written exception in parallel. ChatGPT's directory is open to us if the app sells nothing.
- Traction evidence across the market is thin (directory listings and tutorials, no usage numbers). Ship the minimal surface and measure before building skills, MCP Apps widgets or social cross-posting.

## Open questions before building

1. Credit confirmation: require the quoted cost in the `create_media` call (quote-then-create), rely on `destructiveHint` prompts, or both.
2. Publish default: live immediately, or draft the creator approves in the app.
3. Gating: registered accounts only (OAuth cannot produce a guest), any plan.
4. Templates as a third job (`run_template`) now or later.

## Sources (first-party where available)

Anthropic: connector pre-submission checklist (claude.com/docs/connectors/building/review-criteria), submission (…/submission), authentication (…/authentication), Software Directory Policy (support.claude.com/en/articles/13145358), Claude Code MCP docs (code.claude.com/docs/en/mcp), plugin marketplaces (code.claude.com/docs/en/plugin-marketplaces). OpenAI: Apps SDK submission guidelines and auth (developers.openai.com/apps-sdk), Codex MCP (learn.chatgpt.com/docs/extend/mcp). MCP: specification 2026-07-28 changelog and versioning (modelcontextprotocol.io), tasks extension, registry (registry.modelcontextprotocol.io). Supabase: OAuth 2.1 server guide and MCP authentication (supabase.com/docs/guides/auth/oauth-server). Vercel: mcp-handler AUTHORIZATION.md (github.com/vercel/mcp-handler). Competitors: fal.ai/docs/…/mcp, replicate.com/docs/reference/mcp, elevenlabs.io/docs/eleven-api/resources/mcp-server, krea.ai/docs/developers/mcp, github.com/black-forest-labs/flux-mcp, developers.heygen.com/mcp/overview, hedra.com/docs/…/mcp, higgsfield.ai/mcp and blog 2026-09-02, synthesia.io/mcp, creatify.ai/features/mcp, intercom.help/arcads/…/15655699, foreplay.co/post/ad-library-mcp, opus.pro/blog/opusclip-mcp-tools-reference, canva.dev/docs/mcp, runway.com/mcp and dev.runwayml.com/agents, invideo.io/agents/v0, veed.io/tools/veed-mcp, buffer.com/mcp, hootsuite.com/integrations/mcp, docs.leonardo.ai/docs/connect-to-leonardoai-mcp, recraft.ai/docs/mcp-reference/remote-server, topview.ai/plugin, github.com/gitroomhq/agent-media.
