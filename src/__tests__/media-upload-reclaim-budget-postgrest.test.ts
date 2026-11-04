import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';

import {
  reclaimAbandonedMediaUploads,
  reclaimMediaUploadsWithinBudget,
} from '@/lib/media-upload-reclaim-service';

// One run takes batch after batch, each passing by what this run's earlier
// batches read (`reclaim_checked_at`), through the real PostgREST filter.
it.skipIf(!process.env.AUDIT_STORAGE_CONFIG || !process.env.SUPABASE_TEST_DB_URL)(
  'one run moves past a full batch it kept, to the rows behind it, and stops there',
  async () => {
    const cfg = JSON.parse(readFileSync(process.env.AUDIT_STORAGE_CONFIG!, 'utf8'));
    const url = process.env.SUPABASE_TEST_DB_URL!;
    expect(['localhost', '127.0.0.1']).toContain(new URL(cfg.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(url).hostname);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', cfg.API_URL);
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.origin !== new URL(cfg.API_URL).origin) throw Error('External calls forbidden');
      return originalFetch(input, init);
    });
    const db = new Client({ connectionString: url, statement_timeout: 10000 });
    await db.connect();
    const admin = createClient(cfg.API_URL, cfg.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const user = randomUUID();
    const paths = Array.from({ length: 503 }, (_, i) => `${user}/${String(i).padStart(3, '0')}.png`);
    try {
      expect((await db.query("select id from public.media_upload_intents where consumed_by is not null and storage_cleared_at is null and created_at<now()-interval '48 hours'")).rows).toEqual([]);
      await db.query("insert into auth.users(id,email,aud,role,created_at)values($1,$2,'authenticated','authenticated',now())", [user, `${user}@reclaim-budget.invalid`]);
      for (let start = 0; start < paths.length; start += 10) {
        await Promise.all(paths.slice(start, start + 10).map(async (path) => (
          expect((await admin.storage.from('uploads').upload(path, new Blob(['inert'], { type: 'image/png' }))).error).toBeNull()
        )));
      }
      await db.query("insert into public.media_upload_intents(user_id,storage_path,kind,declared_bytes,created_at,consumed_at,consumed_by) select $1::uuid,$1::uuid::text||'/'||lpad(n::text,3,'0')||'.png','image',5,now()-interval '72 hours'+make_interval(secs=>n),now()-interval '71 hours','generation_input' from generate_series(0,502) n", [user]);
      // The oldest 500 are still read by a creation: the first batch keeps them all.
      const protectedPaths = new Set(paths.slice(0, 500));

      const summary = await reclaimMediaUploadsWithinBudget(admin, {
        reclaimBatch: (client, options) => reclaimAbandonedMediaUploads(client, { ...options, protectedPaths }),
      });

      expect(summary).toMatchObject({ batches: 2, scanned: 503, reclaimed: 3, protectedLegacyReferences: 500 });
      expect((await db.query('select count(*) filter(where storage_cleared_at is not null)::int cleared, count(*) filter(where storage_cleared_at is null)::int uncleared from public.media_upload_intents where user_id=$1', [user])).rows)
        .toEqual([{ cleared: 3, uncleared: 500 }]);
    } finally {
      for (let start = 0; start < paths.length; start += 100) {
        expect((await admin.storage.from('uploads').remove(paths.slice(start, start + 100))).error).toBeNull();
      }
      await db.query('delete from auth.users where id=$1', [user]);
      await db.end();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  },
  60000,
);
