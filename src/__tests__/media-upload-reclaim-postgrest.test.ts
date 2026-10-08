import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient } from '@supabase/supabase-js';
import { it, expect, vi } from 'vitest';
import { reclaimAbandonedMediaUploads } from '@/lib/media-upload-reclaim-service';
it.skipIf(!process.env.AUDIT_STORAGE_CONFIG || !process.env.SUPABASE_TEST_DB_URL).each(['normal', 'remove-error', 'lost-ack', 'mark-error', 'protected', 'unverifiable'] as const)('recovers staged upload reclaim: %s', async (mode) => {
    const cfg = JSON.parse(readFileSync(process.env.AUDIT_STORAGE_CONFIG!, 'utf8')), url = process.env.SUPABASE_TEST_DB_URL!;
    expect(['localhost', '127.0.0.1']).toContain(new URL(cfg.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(url).hostname);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', cfg.API_URL);
    const db = new Client({ connectionString: url, statement_timeout: 10000 });
    await db.connect();
    const originalFetch = globalThis.fetch;
    let armed = false, injected = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const target = new URL(input instanceof Request ? input.url : String(input));
        if (target.origin !== new URL(cfg.API_URL).origin)
            throw Error('External calls forbidden');
        const removal = init?.method === 'DELETE' && target.pathname === '/storage/v1/object/uploads';
        const mark = init?.method === 'PATCH' && target.pathname === '/rest/v1/media_upload_intents';
        if (armed && !injected && ((removal && ['remove-error', 'lost-ack'].includes(mode)) || (mark && mode === 'mark-error'))) {
            injected = true;
            if (mode === 'lost-ack')
                expect((await originalFetch(input, init)).ok).toBe(true);
            return new Response(JSON.stringify({ message: 'Injected local reclaim failure', error: 'injected', statusCode: 503, code: 'XX000' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
        }
        return originalFetch(input, init);
    });
    const admin = createClient(cfg.API_URL, cfg.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const user = randomUUID(), intent = randomUUID(), path = user + '/reclaim.png';
    const state = async () => (await db.query("select storage_cleared_at is not null as cleared,exists(select 1 from storage.objects where bucket_id='uploads' and name=$2) as object_exists from public.media_upload_intents where id=$1", [intent, path])).rows[0];
    try {
        expect((await db.query("select id from public.media_upload_intents where consumed_by is not null and storage_cleared_at is null and created_at<now()-interval '48 hours'")).rows).toEqual([]);
        await db.query("insert into auth.users(id,email,aud,role,created_at)values($1,$2,'authenticated','authenticated',now())", [user, user + '@upload-reclaim.invalid']);
        expect((await admin.storage.from('uploads').upload(path, new Blob(['local disposable bytes'], { type: 'image/png' }))).error).toBeNull();
        await db.query("insert into public.media_upload_intents(id,user_id,storage_path,kind,declared_bytes,created_at,consumed_at,consumed_by)values($1,$2,$3,'image',22,now()-interval '72 hours',now()-interval '71 hours','generation_input')", [intent, user, path]);
        armed = true;
        const first = await reclaimAbandonedMediaUploads(admin, { protectedPaths: mode === 'unverifiable' ? null : new Set(mode === 'protected' ? [path] : []) });
        const firstState = await state();
        if (mode === 'normal')
            expect(firstState).toEqual({ cleared: true, object_exists: false });
        else if (mode === 'remove-error' || mode === 'protected' || mode === 'unverifiable')
            expect(firstState).toEqual({ cleared: false, object_exists: true });
        else
            expect(firstState).toEqual({ cleared: false, object_exists: false });
        if (['remove-error', 'lost-ack', 'mark-error'].includes(mode))
            expect(injected).toBe(true);
        if (mode === 'protected')
            expect(first.protectedLegacyReferences).toBe(1);
        if (mode === 'unverifiable')
            expect(first.kept).toBe(1);
        armed = false;
        const second = await reclaimAbandonedMediaUploads(admin, { protectedPaths: new Set() });
        expect(second.scanned).toBe(mode === "normal" ? 0 : 1);
        expect(await state()).toEqual({ cleared: true, object_exists: false });
        const third = await reclaimAbandonedMediaUploads(admin, { protectedPaths: new Set() });
        expect(third.scanned).toBe(0);
    }
    finally {
        armed = false;
        expect((await admin.storage.from('uploads').remove([path])).error).toBeNull();
        await db.query('delete from auth.users where id=$1', [user]);
        const cleanup = (await db.query("select(select count(*)from auth.users where id=$1)::int users,(select count(*)from public.media_upload_intents where id=$2)::int intents,(select count(*)from storage.objects where bucket_id='uploads' and name=$3)::int objects", [user, intent, path])).rows;
        expect(cleanup).toEqual([{ users: 0, intents: 0, objects: 0 }]);
        await db.end();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    }
});
