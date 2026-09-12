# Local development

Start the local Supabase stack and the Next.js dev server. Nothing here syncs
with production; local data stays as it is.

## Prerequisites

- Docker Desktop running
- Node 24 (`.nvmrc`), dependencies installed with `npm ci`

## Steps

1. Start the local Supabase stack (pin the CLI at 2.75.0; newer versions hang
   silently on start):

   ```bash
   npx supabase start
   ```

2. Make sure `.env.local` points at the **local** stack. Only edit it if it
   currently points at production:

   - The local keys should be active (uncommented):

     ```
     NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
     NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH
     SUPABASE_SERVICE_ROLE_KEY=[REDACTED]
     ```

   - The production keys should be commented out:

     ```
     # NEXT_PUBLIC_SUPABASE_URL=https://ildfmhozpibwiopeavfg.supabase.co
     # NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbG...
     # SUPABASE_SERVICE_ROLE_KEY=[REDACTED]
     ```

3. Start the Next.js dev server:

   ```bash
   npm run dev
   ```

4. Verify both are running:

   - Website: http://localhost:3000
   - Supabase Studio: http://127.0.0.1:54323

## Reference

| Service     | URL                                                     |
|-------------|---------------------------------------------------------|
| Project URL | http://127.0.0.1:54321                                  |
| Studio      | http://127.0.0.1:54323                                  |
| Database    | postgresql://postgres:postgres@127.0.0.1:54322/postgres |

Migrations and the local/production workflow: `docs/supabase-local-prod-workflow.md`.
Every command and convention: `AGENTS.md`.
