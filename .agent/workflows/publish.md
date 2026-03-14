---
description: Publish to production - push local database changes and deploy the app to Vercel
---

# Publish to Production

Deploys the code to Vercel. Does NOT push any database data or migrations — only code changes go live.

## Steps

// turbo-all

1. Switch `.env.local` back to **production** Supabase. Check the file and only edit if it's currently pointing to local:
   - The production keys should be active (uncommented):
     ```
     NEXT_PUBLIC_SUPABASE_URL=https://ildfmhozpibwiopeavfg.supabase.co
     NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlsZGZtaG96cGlid2lvcGVhdmZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA0MzMwMDIsImV4cCI6MjA4NjAwOTAwMn0.9Z8POxK1T4a6SPkuWxngQvYx8snhzEdZSJwog4JkSFU
     ```
   - The local keys should be commented out:
     ```
     # NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
     # NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH
     ```

2. Build the app to check for errors:
```bash
cd "/Users/athuls/UGC copy/ugc-app" && npm run build
```

3. Deploy to Vercel:
```bash
cd "/Users/athuls/UGC copy/ugc-app" && npx vercel --prod
```

4. Verify the live site is working by opening the production URL in the browser.
