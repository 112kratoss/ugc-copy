import { createClient } from '@supabase/supabase-js';
import { iterateStorageObjectsV2 } from '../../src/lib/storage-list-v2';
import { parseBackfillExecutionMode, logBackfillExecutionMode } from './backfill-execution-mode.mjs';

// Dry run by default. Copy through Storage, verify through the atomic RPC,
// switch live descriptors, then let the durable revocation job remove sources.
// Re-running after interruption is safe; immutable checkout quotes keep aliases.
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Supabase operator configuration is required');
const client = createClient(url, key, { auth: { persistSession: false } });
const mode = parseBackfillExecutionMode({ supabaseUrl: url });
logBackfillExecutionMode(mode);

async function run() {
  let after = '';
  let inspected = 0;
  let copied = 0;
  for (;;) {
    let query = client.from('posts').select('id').order('id').limit(100);
    if (after) query = query.gt('id', after);
    const page = await query;
    if (page.error) throw page.error;
    for (const post of page.data ?? []) {
      // Snapshot names before mutating: the revocation worker can delete
      // committed sources while this backfill is still running.
      const paths: string[] = [];
      for await (const object of iterateStorageObjectsV2(client, {
        bucket: 'showcase_media', prefix: `posts/${post.id}`, pageSize: 100,
      })) {
        paths.push(object.path);
        if (paths.length > 10_000) throw new Error('Post prefix exceeds the bounded backfill batch');
      }
      for (const path of paths) {
        inspected += 1;
        if (!mode.execute) continue;
        const target = `private-${path}`;
        const existing = await client.storage.from('post_media').exists(target);
        if (existing.data !== true) {
          const copy = await client.storage.from('showcase_media').copy(path, target, { destinationBucket: 'post_media' });
          if (copy.error) throw copy.error;
        }
        const commit = await client.rpc('commit_uploaded_media_private_copy', { p_public_path: path });
        if (commit.error) throw commit.error;
        copied += 1;
      }
      after = post.id;
    }
    console.info(JSON.stringify({ inspected, copied, complete: (page.data?.length ?? 0) < 100 }));
    if (!page.data || page.data.length < 100) return;
  }
}
run().catch(() => { console.error('Uploaded-media backfill failed; no unverified source was removed. Retry after inspecting the failing batch.'); process.exitCode = 1; });
