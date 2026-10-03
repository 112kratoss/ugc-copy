import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { importWorkflowShareForRoute } from '@/lib/workflow-share-import-service';
import { createWorkflowShareForRoute } from '@/lib/workflow-share-create-service';
import { createStarterGraph } from '@/lib/workflow-canvas';

const connectionString = process.env.SUPABASE_TEST_DB_URL;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
/** Functions that return rows and are read as a table. Every other one returns a single value. */
const ROW_FUNCTIONS = new Set<string>();

function identifier(name: string) {
  if (!IDENTIFIER.test(name)) throw new Error(`Unexpected identifier: ${name}`);
  return name;
}

/** jsonb columns take JSON text; everything else is passed as it is. */
function writable(value: unknown) {
  return value !== null && typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : value;
}

function databaseError(error: unknown) {
  return {
    code: (error as { code?: string } | null)?.code,
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Execute the authoring services' query chains against real SQL on one connection. */
function databaseClient(db: Client, beforeWrite?: () => Promise<void>, afterRead?: (table: string) => Promise<void>): SupabaseClient {
  return {
    from(table: string) {
      identifier(table);
      const filters: string[] = [];
      const values: unknown[] = [];
      const orders: string[] = [];
      let rowLimit: number | null = null;
      let insert: Record<string, unknown> | null = null;
      let update: Record<string, unknown> | null = null;

      const run = async () => {
        if (insert) {
          const keys = Object.keys(insert).map(identifier);
          return (await db.query(
            `insert into public.${table}(${keys.join(',')}) values(${keys.map((_, index) => `$${index + 1}`).join(',')}) returning *`,
            Object.values(insert).map(writable),
          )).rows;
        }
        if (!filters.length) throw new Error(`Unbounded query on ${table}`);
        const where = ` where ${filters.join(' and ')}`;
        if (update) {
          await beforeWrite?.();
          const keys = Object.keys(update).map(identifier);
          const rows = (await db.query(
            `update public.${table} set ${keys.map((key, index) => `${key}=$${values.length + index + 1}`).join(',')}${where} returning *`,
            [...values, ...Object.values(update).map(writable)],
          )).rows;
          return rows;
        }
        const rows = (await db.query(
          `select * from public.${table}${where}${orders.length ? ` order by ${orders.join(',')}` : ''}${rowLimit === null ? '' : ` limit ${rowLimit}`}`,
          values,
        )).rows;
        await afterRead?.(table);
        return rows;
      };
      const answer = async (single: boolean, required: boolean) => {
        try {
          const rows = await run();
          if (!single) return { data: rows, error: null };
          if (rows.length > 1 || (required && !rows.length)) {
            return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
          }
          return { data: rows[0] ?? null, error: null };
        } catch (error) {
          return { data: null, error: databaseError(error) };
        }
      };
      const compare = (operator: string) => (column: string, value: unknown) => {
        values.push(value);
        filters.push(`${identifier(column)}${operator}$${values.length}`);
        return query;
      };
      const query = {
        select: () => query,
        insert(value: Record<string, unknown>) {
          insert = value;
          return query;
        },
        update(value: Record<string, unknown>) {
          update = value;
          return query;
        },
        eq: compare('='),
        neq: compare('<>'),
        in(column: string, value: unknown[]) {
          values.push(value);
          filters.push(`${identifier(column)}=any($${values.length})`);
          return query;
        },
        order(column: string, options?: { ascending?: boolean }) {
          orders.push(`${identifier(column)} ${options?.ascending === false ? 'desc' : 'asc'}`);
          return query;
        },
        limit(value: number) {
          if (!Number.isInteger(value) || value < 1) throw new Error('Invalid limit');
          rowLimit = value;
          return query;
        },
        single: () => answer(true, true),
        maybeSingle: () => answer(true, false),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => (
          answer(false, false).then(resolve, reject)
        ),
      };
      return query;
    },
    async rpc(name: string, args: Record<string, unknown> = {}) {
      identifier(name);
      const call = `public.${name}(${Object.keys(args).map((key, index) => `${identifier(key)}=>$${index + 1}`).join(',')})`;
      try {
        const { rows } = await db.query(
          ROW_FUNCTIONS.has(name) ? `select * from ${call}` : `select ${call} as result`,
          Object.values(args).map(writable),
        );
        const data = ROW_FUNCTIONS.has(name) ? rows : rows[0].result;
        return { data, error: null };
      } catch (error) {
        return { data: null, error: databaseError(error) };
      }
    },
  } as unknown as SupabaseClient;
}

describe.skipIf(!connectionString)('workflow share actual SQL audit', () => {
  let admin: Client;
  let owner: Client;
  let importer: Client;
  let serviceOne: Client;
  let serviceTwo: Client;
  let userId: string;
  let importerId: string;
  let canvasId: string;
  let shareId: string;
  const graph = createStarterGraph();
  beforeAll(async () => {
    expect(['localhost','127.0.0.1']).toContain(new URL(connectionString!).hostname);
    [admin,owner,importer,serviceOne,serviceTwo] = Array.from({ length:5 }, () => new Client({ connectionString,statement_timeout:10_000 }));
    await Promise.all([admin,owner,importer,serviceOne,serviceTwo].map(db => db.connect()));
    await owner.query('set role authenticated');
    await importer.query('set role authenticated');
    await serviceOne.query('set role service_role');
    await serviceTwo.query('set role service_role');
  });
  afterAll(async () => { await Promise.all([admin,owner,importer,serviceOne,serviceTwo].map(db => db?.end())); });
  beforeEach(async () => {
    userId = randomUUID(); importerId = randomUUID(); canvasId = randomUUID();
    for (const id of [userId,importerId]) await admin.query("insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())",[id,`${id}@example.invalid`]);
    await owner.query("select set_config('request.jwt.claim.sub',$1,false)",[userId]);
    await importer.query("select set_config('request.jwt.claim.sub',$1,false)",[importerId]);
    await admin.query("insert into public.workflow_canvases(id,user_id,title,graph,revision) values($1,$2,'Share SQL audit',$3,4)",[canvasId,userId,JSON.stringify(graph)]);
    const result = await createWorkflowShareForRoute({ canvasId,userId,userSupabase:databaseClient(owner),serviceSupabase:databaseClient(serviceOne),origin:'https://example.invalid' });
    expect(result.ok).toBe(true);
    shareId = (result.body.share as { id:string }).id;
  });
  afterEach(async () => {
    await admin.query('delete from public.workflow_canvases where user_id=any($1)',[[userId,importerId]]);
    await admin.query('delete from public.backend_rate_limits where subject_key=any($1)',[[userId,importerId]]);
    await admin.query('delete from auth.users where id=any($1)',[[userId,importerId]]);
  });
  const importShare = (serviceSupabase = databaseClient(serviceOne)) => importWorkflowShareForRoute({ origin:'https://example.invalid',shareId,userId:importerId,userSupabase:databaseClient(importer),serviceSupabase });
  const count = async () => (await admin.query('select import_count from public.workflow_shares where id=$1',[shareId])).rows[0].import_count;
  it('keeps immutable share importable after its source is deleted', async () => {
    await admin.query('delete from public.workflow_canvases where id=$1',[canvasId]);
    expect((await admin.query('select source_canvas_id from public.workflow_shares where id=$1',[shareId])).rows[0].source_canvas_id).toBeNull();
    expect(await importShare()).toMatchObject({ ok:true });
    expect(await count()).toBe(1);
  });
  it('creates independent copies for repeated imports', async () => {
    const first = await importShare(); const second = await importShare();
    expect(first.ok).toBe(true); expect(second.ok).toBe(true);
    expect((first.body.canvas as { id:string }).id).not.toBe((second.body.canvas as { id:string }).id);
    expect(await count()).toBe(2);
  });
  it('counts both successful imports whose share reads see the same counter', async () => {
    let competing = false;
    const delayed = databaseClient(serviceOne,undefined,async table => {
      if (table !== 'workflow_shares' || competing) return;
      competing = true;
      expect(await importShare(databaseClient(serviceTwo))).toMatchObject({ ok:true });
    });
    expect(await importShare(delayed)).toMatchObject({ ok:true });
    expect((await admin.query('select count(*)::int as n from public.workflow_canvases where user_id=$1',[importerId])).rows[0].n).toBe(2);
    expect(await count()).toBe(2);
  });
  it('serializes concurrent service-role increments without lost updates', async () => {
    const first = databaseClient(serviceOne);
    const second = databaseClient(serviceTwo);
    const batches = await Promise.all([first,second].map(async client => {
      const results = [];
      for (let index = 0; index < 6; index += 1) {
        results.push(await client.rpc('increment_workflow_share_import_count',{ p_share_id:shareId }));
      }
      return results;
    }));
    const results = batches.flat();
    for (const result of results) expect(result.error).toBeNull();
    expect(results.map(result => result.data).sort((a: number,b: number) => a-b)).toEqual(Array.from({ length:12 }, (_, index) => index+1));
    expect(await count()).toBe(12);
  });
  it('rejects a forged import owner under authenticated RLS without counting it', async () => {
    const result = await importWorkflowShareForRoute({ origin:'https://example.invalid',shareId,userId,userSupabase:databaseClient(importer),serviceSupabase:databaseClient(serviceOne) });
    expect(result).toMatchObject({ ok:false,status:500 });
    expect(await count()).toBe(0);
    expect((await admin.query('select count(*)::int as n from public.workflow_canvases where user_id=$1',[importerId])).rows[0].n).toBe(0);
  });
  it('does not let an authenticated user call the privileged counter RPC', async () => {
    const result = await databaseClient(importer).rpc('increment_workflow_share_import_count',{ p_share_id:shareId });
    expect(result.error).toMatchObject({ code:'42501' });
    expect(await count()).toBe(0);
  });
  it('preserves a successful copy but does not invent an increment after SQL rejects it', async () => {
    await admin.query(`create function public.audit_share_count_failure() returns trigger language plpgsql as $$
      begin if new.id='${shareId}'::uuid then raise exception 'audit share count rejected'; end if; return new; end $$`);
    await admin.query('create trigger audit_share_count_failure before update on public.workflow_shares for each row execute function public.audit_share_count_failure()');
    try {
      expect(await importShare()).toMatchObject({ ok:true,body:{ share:{ importCount:0 } } });
      expect(await count()).toBe(0);
      expect((await admin.query('select count(*)::int as n from public.workflow_canvases where user_id=$1',[importerId])).rows[0].n).toBe(1);
    } finally {
      await admin.query('drop trigger audit_share_count_failure on public.workflow_shares');
      await admin.query('drop function public.audit_share_count_failure()');
    }
  });
  it('does not create a share from another user canvas', async () => {
    const result = await createWorkflowShareForRoute({ canvasId,userId:importerId,userSupabase:databaseClient(importer),serviceSupabase:databaseClient(serviceOne),origin:'https://example.invalid' });
    expect(result).toMatchObject({ ok:false,status:404 });
    expect((await admin.query('select count(*)::int as n from public.workflow_shares where source_canvas_id=$1',[canvasId])).rows[0].n).toBe(1);
  });
});
