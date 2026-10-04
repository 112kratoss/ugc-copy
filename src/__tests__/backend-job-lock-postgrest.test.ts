import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withBackendJobLock } from '@/lib/backend-job-lock';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath || !connectionString)('job leases through actual PostgREST', () => {
  let db: Client;
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  let name: string;
  const acquire = (owner: string, ttl = 30) => admin.rpc('try_acquire_backend_job_lock', { p_name: name, p_ttl_seconds: ttl, p_locked_by: owner });
  const release = (owner: string) => admin.rpc('release_backend_job_lock', { p_name: name, p_locked_by: owner });
  const row = async () => (await db.query('select locked_by from public.backend_job_locks where name=$1', [name])).rows;
  beforeAll(async () => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    anon = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false } });
    db = new Client({ connectionString, statement_timeout: 10000 });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(() => { name = 'audit-lock-' + randomUUID(); });
  afterEach(async () => {
    await db.query('delete from public.backend_job_locks where name=$1', [name]);
    expect(await row()).toEqual([]);
  });

  it('allows only one of eight concurrent owners', async () => {
    const owners = Array.from({ length: 8 }, () => randomUUID());
    const results = await Promise.all(owners.map(owner => acquire(owner)));
    expect(results.every(result => result.error === null)).toBe(true);
    expect(results.filter(result => result.data === true)).toHaveLength(1);
    expect(await row()).toEqual([{ locked_by: owners[results.findIndex(result => result.data === true)] }]);
  });

  it('renews the current owner and refuses a foreign release', async () => {
    expect(await acquire('owner-a', 1)).toMatchObject({ data: true, error: null });
    expect(await acquire('owner-a', 30)).toMatchObject({ data: true, error: null });
    expect(await release('owner-b')).toMatchObject({ data: false, error: null });
    expect(await acquire('owner-b')).toMatchObject({ data: false, error: null });
    expect(await release('owner-a')).toMatchObject({ data: true, error: null });
    expect(await acquire('owner-b')).toMatchObject({ data: true, error: null });
  });

  it('prevents a stale owner from releasing a replacement lease', async () => {
    expect(await acquire('old-owner')).toMatchObject({ data: true, error: null });
    await db.query("update public.backend_job_locks set locked_until=now()-interval '1 second' where name=$1", [name]);
    expect(await acquire('new-owner')).toMatchObject({ data: true, error: null });
    expect(await release('old-owner')).toMatchObject({ data: false, error: null });
    expect(await row()).toEqual([{ locked_by: 'new-owner' }]);
  });

  it('releases the real lease after a failing task and permits a retry', async () => {
    await expect(withBackendJobLock(admin, { name, ttlSeconds: 30, owner: 'failing-worker' }, async () => { throw new Error('fixture task failed'); })).rejects.toThrow('fixture task failed');
    expect(await row()).toEqual([]);
    expect(await withBackendJobLock(admin, { name, ttlSeconds: 30, owner: 'retry-worker' }, async () => 'done')).toEqual({ acquired: true, value: 'done' });
    expect(await row()).toEqual([]);
  });

  it('does not invoke a task while another lease is live', async () => {
    expect(await acquire('active-worker')).toMatchObject({ data: true, error: null });
    let ran = false;
    expect(await withBackendJobLock(admin, { name, ttlSeconds: 30, owner: 'competing-worker' }, async () => { ran = true; })).toEqual({ acquired: false, reason: 'already_running' });
    expect(ran).toBe(false);
    expect(await row()).toEqual([{ locked_by: 'active-worker' }]);
  });

  it('rejects invalid TTL and anonymous acquisition without a lease', async () => {
    for (const ttl of [0, 3601]) expect((await acquire('owner', ttl)).error).not.toBeNull();
    expect((await anon.rpc('try_acquire_backend_job_lock', { p_name: name, p_ttl_seconds: 30, p_locked_by: 'forged' })).error?.code).toBe('42501');
    expect(await row()).toEqual([]);
  });

  it('recovers a killed worker only after its actual lease expires', async () => {
    const child = spawn(process.execPath, ['-e', `
      const {readFileSync}=require('node:fs');
      const {createClient}=require('@supabase/supabase-js');
      const c=JSON.parse(readFileSync(process.env.AUDIT_STORAGE_CONFIG,'utf8'));
      const client=createClient(c.API_URL,c.SERVICE_ROLE_KEY,{auth:{persistSession:false}});
      client.rpc('try_acquire_backend_job_lock',{p_name:process.env.AUDIT_LOCK_NAME,p_ttl_seconds:2,p_locked_by:'killed-worker'}).then(r=>{
        if(r.error||r.data!==true)process.exit(1);
        process.stdout.write('acquired\\n');setInterval(()=>{},1000);
      }).catch(()=>process.exit(1));
    `], { env: { ...process.env, AUDIT_LOCK_NAME: name }, stdio: ['ignore', 'pipe', 'pipe'] });
    const exit = once(child, 'exit');
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Worker acquisition timed out')), 5000);
        child.stdout.once('data', data => {
          clearTimeout(timeout);
          if (data.toString().includes('acquired')) resolve();
          else reject(new Error('Unexpected worker response'));
        });
        child.once('exit', () => { clearTimeout(timeout); reject(new Error('Worker stopped before acquiring')); });
        child.once('error', error => { clearTimeout(timeout); reject(error); });
      });
      child.kill('SIGKILL');
      await exit;
      expect(await acquire('replacement-worker')).toMatchObject({ data: false, error: null });
      await delay(2100);
      expect(await acquire('replacement-worker')).toMatchObject({ data: true, error: null });
      expect(await row()).toEqual([{ locked_by: 'replacement-worker' }]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exit;
    }
  }, 10000);
});
