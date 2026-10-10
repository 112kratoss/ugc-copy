import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { runWorkflowRunStepsBackendJob } from '@/lib/backend-job-executions';

const modes = ['empty', 'workflow-pending', 'workflow-heartbeat', 'workflow-lock', 'template-due', 'workflow-stranded', 'template-stranded', 'template-prune', 'locked'] as const;

it.skipIf(!process.env.AUDIT_STORAGE_CONFIG || !process.env.SUPABASE_TEST_DB_URL).each(modes)(
  'records actual workflow scheduler admission and recovery: %s', async mode => {
    const config = JSON.parse(readFileSync(process.env.AUDIT_STORAGE_CONFIG!, 'utf8'));
    const connectionString = process.env.SUPABASE_TEST_DB_URL!;
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString).hostname);
    const db = new Client({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    await db.connect();
    let armed = true;
    let injected = 0;
    const requests: string[] = [];
    const admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
      global: { fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== new URL(config.API_URL).origin) throw new Error('External requests forbidden');
        requests.push(url.pathname);
        const path = url.pathname.replace('/rest/v1/', '');
        const failure = mode === 'workflow-pending' && path === 'workflow_run_step_jobs' && url.searchParams.get('status') === 'eq.pending'
          || mode === 'workflow-heartbeat' && path === 'workflow_run_step_jobs' && url.searchParams.get('heartbeat_at')?.startsWith('lte.')
          || mode === 'workflow-lock' && path === 'workflow_run_step_jobs' && url.searchParams.get('heartbeat_at') === 'is.null'
          || mode === 'template-due' && path === 'rpc/has_due_template_run_jobs'
          || mode === 'workflow-stranded' && path === 'rpc/list_stalled_workflow_runs_without_live_jobs'
          || mode === 'template-stranded' && path === 'template_runs'
          || mode === 'template-prune' && path === 'rpc/prune_template_run_jobs';
        if (armed && failure) {
          injected++;
          return Promise.resolve(new Response(JSON.stringify({ code: 'XX000', message: 'Fixture workflow discovery unavailable' }), {
            status: 503, headers: { 'Content-Type': 'application/json' },
          }));
        }
        if (path === 'rpc/prune_backend_job_runs') throw new Error('Unexpected global run-history prune');
        return fetch(input, init);
      } },
    });
    const ids = [randomUUID(), randomUUID()].map(id => 'audit-workflow-job-' + id);
    const owner = randomUUID(), template = randomUUID(), runId = randomUUID();
    const lockOwner = 'audit-workflow-lock-' + randomUUID();
    const now = new Date();
    if (now.getUTCMinutes() < 10) now.setUTCHours(now.getUTCHours() - 1);
    now.setUTCMinutes(10, 0, 0);
    const run = (index: number) => runWorkflowRunStepsBackendJob({ serviceClient: admin, requestId: ids[index], startedAtMs: now.getTime() });
    try {
      expect((await db.query("select id from public.workflow_canvas_runs where status='processing'")).rows).toEqual([]);
      expect((await db.query("select id from public.template_runs where status in ('queued','processing')")).rows).toEqual([]);
      expect((await db.query("select id from public.workflow_run_step_jobs where status in ('pending','processing')")).rows).toEqual([]);
      expect((await db.query("select name from public.backend_job_locks where name='workflow-run-steps'")).rows).toEqual([]);
      if (mode === 'locked') {
        await db.query("insert into auth.users(id,email,aud,role,created_at)values($1,$2,'authenticated','authenticated',now())", [owner, owner + '@workflow-job.invalid']);
        await db.query("insert into public.templates(id,name,creator_user_id,status,is_active)values($1,'Workflow scheduler fixture',$2,'draft',true)", [template, owner]);
        await db.query(`insert into public.template_runs(id,template_id,user_id,graph_snapshot,graph_hash,input_manifest,input_storage_paths,output_node_id,output_kind,status,estimated_total_credits,estimated_remaining_credits)
          values($1,$2,$3,'{}',repeat('a',64),'[]','{}','output','image','queued',0,0)`, [runId, template, owner]);
        expect((await admin.rpc('enqueue_template_run_job', { p_run_id: runId })).error).toBeNull();
        expect(await admin.rpc('try_acquire_backend_job_lock', { p_name: 'workflow-run-steps', p_ttl_seconds: 60, p_locked_by: lockOwner })).toMatchObject({ data: true, error: null });
      }
      const failure = !['empty', 'locked'].includes(mode);
      expect(await run(0)).toMatchObject({ success: !failure, status: failure ? 'failed' : 'skipped' });
      expect(injected > 0).toBe(failure);
      const record = (await db.query('select status,skip_reason,error_message from public.backend_job_runs where request_id=$1', [ids[0]])).rows;
      expect(record).toHaveLength(1);
      if (failure) expect(record[0]).toMatchObject({ status: 'failed', error_message: 'Fixture workflow discovery unavailable' });
      else expect(record[0]).toMatchObject({ status: 'skipped', skip_reason: mode === 'locked' ? 'already_running' : 'no_due_workflow_run_steps' });
      expect(requests).not.toContain('/rest/v1/rpc/claim_template_run_jobs');
      expect(requests).not.toContain('/rest/v1/rpc/claim_workflow_run_step_jobs');
      if (mode === 'locked') {
        expect((await db.query("select locked_by from public.backend_job_locks where name='workflow-run-steps'")).rows).toEqual([{ locked_by: lockOwner }]);
        expect((await db.query('select status,attempt_count from public.template_run_jobs where run_id=$1', [runId])).rows).toEqual([{ status: 'pending', attempt_count: 0 }]);
        // Remove only this disposable queued run; the next invocation is an empty retry.
        await db.query('delete from public.template_runs where id=$1', [runId]);
        expect(await admin.rpc('release_backend_job_lock', { p_name: 'workflow-run-steps', p_locked_by: lockOwner })).toMatchObject({ data: true, error: null });
      }
      armed = false;
      expect(await run(1)).toMatchObject({ success: true, status: 'skipped', reason: 'no_due_workflow_run_steps' });
      expect((await db.query('select status from public.backend_job_runs where request_id=$1', [ids[1]])).rows).toEqual([{ status: 'skipped' }]);
    } finally {
      armed = false;
      await admin.rpc('release_backend_job_lock', { p_name: 'workflow-run-steps', p_locked_by: lockOwner });
      await db.query('delete from public.template_runs where id=$1', [runId]);
      await db.query('delete from public.templates where id=$1', [template]);
      await db.query('delete from auth.users where id=$1', [owner]);
      await db.query('delete from public.backend_job_runs where request_id=any($1::text[])', [ids]);
      expect((await db.query(`select
        (select count(*) from auth.users where id=$1)::int users,
        (select count(*) from public.template_runs where id=$2)::int runs,
        (select count(*) from public.template_run_jobs where run_id=$2)::int jobs,
        (select count(*) from public.backend_job_runs where request_id=any($3::text[]))::int history,
        (select count(*) from public.backend_job_locks where locked_by=$4)::int locks`, [owner, runId, ids, lockOwner])).rows)
        .toEqual([{ users: 0, runs: 0, jobs: 0, history: 0, locks: 0 }]);
      await db.end();
    }
  }, 30000,
);
