import { readFileSync } from 'node:fs';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient } from '@supabase/supabase-js';
import { expect, it } from 'vitest';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;

it.skipIf(!configPath || !connectionString).each(['after-scan', 'after-removal', 'after-clearing'])(
  'recovers upload cleanup after actual SIGKILL %s', async (phase) => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    const admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== new URL(config.API_URL).origin) throw Error('External calls forbidden');
        return fetch(input, init);
      } },
    });
    const db = new Client({ connectionString, statement_timeout: 10000 });
    await db.connect();
    const owner = randomUUID(), intent = randomUUID(), abandoned = randomUUID();
    const paths = [owner + '/consumed.png', owner + '/abandoned.png'];
    const children = new Set<ChildProcess>();
    const startWorker = (stage: string) => {
      const child = fork('src/__tests__/media-upload-reclaim-worker.cjs', [], {
        execArgv: ['--import', 'tsx'], silent: true,
        env: { NODE_ENV: 'test', PATH: process.env.PATH, TSX_TSCONFIG_PATH: 'tsconfig.mobile-push-worker.json', AUDIT_STORAGE_CONFIG: configPath, AUDIT_RECLAIM_PHASE: stage },
      });
      children.add(child);
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => { children.delete(child); resolve({ code, signal }); }));
      let diagnostic = '';
      child.stderr?.on('data', data => { diagnostic = (diagnostic + String(data)).slice(-2000); });
      child.stdout?.resume();
      const checkpoint = new Promise<{ stage: string; summary?: { scanned: number; reclaimed: number; rowsDropped: number } }>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Worker checkpoint timed out: ' + diagnostic)), 20000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(Error('Worker exited before checkpoint: ' + diagnostic)); });
        child.on('message', message => {
          const result = message as { stage: string; summary?: { scanned: number; reclaimed: number; rowsDropped: number } };
          if (result.stage === stage || result.stage === 'completed') { clearTimeout(timer); resolve(result); }
          else if (result.stage === 'failed') { clearTimeout(timer); reject(Error('Worker failed: ' + diagnostic)); }
        });
      });
      return { child, closed, checkpoint };
    };
    try {
      expect((await db.query("select id from public.media_upload_intents where consumed_by is not null and storage_cleared_at is null and created_at<now()-interval '48 hours'")).rows).toEqual([]);
      await db.query("insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())", [owner, owner + '@reclaim-worker.invalid']);
      for (const path of paths) expect((await admin.storage.from('uploads').upload(path, new Blob(['disposable'], { type: 'image/png' }))).error).toBeNull();
      await db.query("insert into public.media_upload_intents(id,user_id,storage_path,kind,created_at,consumed_at,consumed_by) values($1,$2,$3,'image',now()-interval '72 hours',now(),'generation_input'),($4,$2,$5,'image',now()-interval '72 hours',null,null)", [intent, owner, paths[0], abandoned, paths[1]]);
      const worker = startWorker(phase);
      expect((await worker.checkpoint).stage).toBe(phase);
      expect((await db.query('select reclaim_checked_at is not null as checked,storage_cleared_at is not null as cleared from public.media_upload_intents where id=$1', [intent])).rows).toEqual([{ checked: true, cleared: phase === 'after-clearing' }]);
      expect((await db.query("select count(*)::int count from storage.objects where bucket_id='uploads' and name=$1", [paths[0]])).rows).toEqual([{ count: phase === 'after-scan' ? 1 : 0 }]);
      worker.child.kill('SIGKILL');
      expect((await worker.closed).signal).toBe('SIGKILL');
      const replacement = startWorker('complete');
      expect(await replacement.checkpoint).toMatchObject({ stage: 'completed', summary: {
        scanned: phase === 'after-clearing' ? 0 : 1,
        reclaimed: phase === 'after-scan' ? 1 : 0,
        rowsDropped: phase === 'after-removal' ? 1 : 0,
      } });
      expect((await replacement.closed).code).toBe(0);
      const duplicate = startWorker('complete');
      expect(await duplicate.checkpoint).toMatchObject({ stage: 'completed', summary: { scanned: 0 } });
      expect((await duplicate.closed).code).toBe(0);
      expect((await db.query('select storage_cleared_at is not null as cleared from public.media_upload_intents where id=$1', [intent])).rows).toEqual([{ cleared: true }]);
      const missing = await admin.storage.from('uploads').download(paths[0]);
      expect(missing.data).toBeNull(); expect(missing.error).not.toBeNull();
      // The flag remains absent in the isolated worker. A never-consumed draft
      // must stay untouched across the interrupted, recovery and duplicate runs.
      expect((await db.query('select reclaim_checked_at,storage_cleared_at from public.media_upload_intents where id=$1', [abandoned])).rows).toEqual([{ reclaim_checked_at: null, storage_cleared_at: null }]);
      expect((await admin.storage.from('uploads').download(paths[1])).error).toBeNull();
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
        child.kill('SIGKILL'); await closed;
      }
      expect((await admin.storage.from('uploads').remove(paths)).error).toBeNull();
      await db.query('delete from auth.users where id=$1', [owner]);
      expect((await db.query("select(select count(*)from auth.users where id=$1)::int users,(select count(*)from public.media_upload_intents where user_id=$1)::int intents,(select count(*)from storage.objects where bucket_id='uploads' and name=any($2::text[]))::int objects", [owner, paths])).rows).toEqual([{ users: 0, intents: 0, objects: 0 }]);
      await db.end();
    }
  }, 40000,
);
