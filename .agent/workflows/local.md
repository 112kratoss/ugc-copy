---
description: Start local development - sync database from production and run the app locally
---

# Start Local Development

Starts the local Supabase database and Next.js dev server. No syncing with production — your local data stays as-is.

## Prerequisites
- Docker Desktop must be running

## Steps

// turbo-all

1. Start the local Supabase instance:
```bash
cd "/Users/athuls/UGC copy/ugc-app" && npx supabase start
```

2. Ensure `.env.local` uses the **local** Supabase instance. Check the file and only edit if it's currently pointing to production:
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
cd "/Users/athuls/UGC copy/ugc-app" && npm run dev
```

4. Verify both are running by opening in the browser:
   - **Website**: http://localhost:3000
   - **Supabase Studio**: http://127.0.0.1:54323

## Reference
| Service       | URL                                    |
|---------------|----------------------------------------|
| Project URL   | http://127.0.0.1:54321                 |
| Studio        | http://127.0.0.1:54323                 |
| Database      | postgresql://postgres:postgres@127.0.0.1:54322/postgres |
