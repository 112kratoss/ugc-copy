---
description: Publish to production — superseded; releases ship via the production-release GitHub workflow
---

# Publish to Production (superseded)

Do NOT deploy manually. Production releases are owned by
`.github/workflows/production-release.yml`: after the exact `main` SHA passes
the Quality workflow, it applies Supabase migrations and the edge function,
stages a production-configured Vercel deployment, verifies public and
authenticated health, then promotes and verifies the live SHA.

To ship: merge to `main`, let Quality go green, and let the release workflow
run. Gates, environment contract, and recovery procedures:
`docs/production-deployment-runbook.md`.

Manual `npx vercel --prod` is recovery-only — follow the runbook, never this
file's old steps.
