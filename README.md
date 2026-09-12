# Magicbooklet

An AI UGC creation platform: image, video, and motion generation (provider: Kie.ai), a public showcase feed with a social layer, unified search, a creator marketplace with paid resource bundles, templates, and a node-based workflow builder. Live at [magicbooklet.com](https://magicbooklet.com).

This repository holds all three parts of the product:

| Part | Where | Runs on |
|---|---|---|
| Web app + API | `src/` (Next.js 16 App Router, React 19, Tailwind v4) | Vercel, region `bom1` |
| Backend of record | `supabase/` (Postgres 17, Auth, Storage, RLS, RPCs, one edge function) | Supabase |
| Mobile app | `ugc-mobile/` (Expo SDK 55 + expo-router; its own npm workspace) | App Store, Google Play, OTA via expo-updates |

## Start here

- [AGENTS.md](AGENTS.md): every command, the architecture, conventions, and the cautions that matter (also read by coding agents).
- [docs/README.md](docs/README.md): index of the operational runbooks and reference material.
- [docs/local-development.md](docs/local-development.md): the local Supabase stack and dev server.

## Quick start (web)

```bash
nvm use            # Node 24, from .nvmrc
npm ci
cp .env.example .env.local   # then fill in the values you have
npm run dev        # http://localhost:3000
```

Gates that CI runs on every pull request, in the same order:

```bash
npm test && npm run lint && npm run typecheck && npm run typecheck:scripts && npm run typecheck:tests
npm run build && npm run build:verify
```

Mobile lives in `ugc-mobile/` with its own `npm ci`, `npm test`, and `npm run typecheck`; see its README.

## Layout

```
.github/workflows/   quality, production release, mobile store release, watchdogs
config/              catalog release manifests, performance budgets, Lighthouse config
content/blog/        blog posts (markdown)
contracts/           versioned web <-> mobile JSON contracts
docs/                runbooks at the root; design/, audits/, plans/, research/, model-api-references/
public/              static assets
scripts/             backfills, ops CLIs, certification harness, build checks
src/app/             routes (thin route.ts shells) and route-local UI
src/lib/             route adapters, services, and domain modules (flat, prefix-organised)
src/__tests__/       all web unit and integration tests
supabase/            migrations, pgTAP tests, the kie-webhook edge function
tests/e2e/           Playwright smoke tests
ugc-mobile/          the Expo app
```

Production deploys are owned by the release workflow after `main` passes Quality; nothing deploys by hand. Details: [docs/production-deployment-runbook.md](docs/production-deployment-runbook.md).
