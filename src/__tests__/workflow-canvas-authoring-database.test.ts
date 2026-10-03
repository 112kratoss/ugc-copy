import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { publishWorkflowCanvasForRoute, restoreWorkflowCanvasHistoryForRoute } from '@/lib/workflow-canvas-lifecycle-service';
import { patchWorkflowCanvasForRoute } from '@/lib/workflow-canvas-route-service';
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
function databaseClient(db: Client, beforeWrite?: () => Promise<void>): SupabaseClient {
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
        return (await db.query(
          `select * from public.${table}${where}${orders.length ? ` order by ${orders.join(',')}` : ''}${rowLimit === null ? '' : ` limit ${rowLimit}`}`,
          values,
        )).rows;
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

describe.skipIf(!connectionString)('canvas authoring with actual authenticated SQL', () => {
  let admin: Client;
  let owner: Client;
  let other: Client;
  let userId: string;
  let canvasId: string;
  let entryId: string;
  let client: SupabaseClient;
  const graph = createStarterGraph();
  beforeAll(async () => {
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    admin = new Client({ connectionString, statement_timeout: 10_000 });
    owner = new Client({ connectionString, statement_timeout: 10_000 });
    other = new Client({ connectionString, statement_timeout: 10_000 });
    await Promise.all([admin.connect(), owner.connect(), other.connect()]);
    await owner.query('set role authenticated');
    await other.query('set role authenticated');
  });
  afterAll(async () => { await Promise.all([admin?.end(), owner?.end(), other?.end()]); });
  beforeEach(async () => {
    userId = randomUUID(); canvasId = randomUUID(); entryId = randomUUID();
    await admin.query("insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())", [userId, `${userId}@example.invalid`]);
    await owner.query("select set_config('request.jwt.claim.sub',$1,false)", [userId]);
    await other.query("select set_config('request.jwt.claim.sub',$1,false)", [userId]);
    await admin.query("insert into public.workflow_canvases(id,user_id,title,graph,revision) values($1,$2,'Current authoring audit',$3,4)", [canvasId,userId,JSON.stringify(graph)]);
    await admin.query("insert into public.workflow_canvas_history(id,canvas_id,user_id,title,graph,revision,kind) values($1,$2,$3,'Historical title',$4,2,'draft')", [entryId,canvasId,userId,JSON.stringify({ ...graph,viewport:{ x:100,y:200,zoom:0.5 } })]);
    client = databaseClient(owner);
  });
  afterEach(async () => {
    await admin.query('delete from public.workflow_canvases where id=$1', [canvasId]);
    await admin.query('delete from auth.users where id=$1', [userId]);
  });
  const publish = (supabase = client) => publishWorkflowCanvasForRoute({ canvasId,userId,supabase });
  const restore = (supabase = client) => restoreWorkflowCanvasHistoryForRoute({ canvasId,entryId,userId,supabase });
  const save = (baseRevision = 4, supabase = databaseClient(other)) => patchWorkflowCanvasForRoute({ canvasId,userId,supabase,body:{ title:'Newer saved title',baseRevision } });
  const saved = async () => (await admin.query('select title,graph,revision,status from public.workflow_canvases where id=$1',[canvasId])).rows[0];
  const snapshots = async () => (await admin.query('select title,revision,kind from public.workflow_canvas_history where canvas_id=$1 order by revision',[canvasId])).rows;

  it.each(['publish','restore'] as const)('rejects %s if a save commits after its read', async (action) => {
    client = databaseClient(owner, async () => { expect(await save()).toMatchObject({ ok:true }); });
    expect.soft(await (action === 'publish' ? publish() : restore())).toMatchObject({ ok:false,status:409 });
    expect.soft(await saved()).toMatchObject({ title:'Newer saved title',revision:5,status:'draft',graph:JSON.parse(JSON.stringify(graph)) });
    expect(await snapshots()).toHaveLength(2);
  });
  it('rejects a restore that loses to another restore at the same revision', async () => {
    client = databaseClient(owner, async () => { expect(await restore(databaseClient(other))).toMatchObject({ ok:true }); });
    expect.soft(await restore()).toMatchObject({ ok:false,status:409 });
    expect.soft(await saved()).toMatchObject({ title:'Historical title',revision:5,status:'draft' });
    expect(await snapshots()).toHaveLength(2);
  });
  it('does not decrease the revision when two saves commit before a delayed publish', async () => {
    client = databaseClient(owner, async () => {
      expect(await save()).toMatchObject({ ok:true });
      expect(await patchWorkflowCanvasForRoute({ canvasId,userId,supabase:databaseClient(other),body:{ title:'Latest saved title',baseRevision:5 } })).toMatchObject({ ok:true });
    });
    expect.soft(await publish()).toMatchObject({ ok:false,status:409 });
    expect.soft(await saved()).toMatchObject({ title:'Latest saved title',revision:6,status:'draft' });
    expect(await snapshots()).toHaveLength(3);
  });
  it.each(['publish','restore'] as const)('preserves a committed %s when an older save resumes', async (action) => {
    const delayedSave = databaseClient(owner, async () => {
      expect(await (action === 'publish' ? publish(databaseClient(other)) : restore(databaseClient(other)))).toMatchObject({ ok:true });
    });
    expect(await save(4,delayedSave)).toMatchObject({ ok:false,status:409 });
    expect(await saved()).toMatchObject({ revision:5,title:action === 'publish' ? 'Current authoring audit' : 'Historical title' });
    expect(await snapshots()).toHaveLength(2);
  });
  it.each(['publish','restore'] as const)('enforces authenticated ownership for %s', async (action) => {
    await owner.query("select set_config('request.jwt.claim.sub',$1,false)",[randomUUID()]);
    expect(await (action === 'publish' ? publish() : restore())).toMatchObject({ ok:false,status:404 });
    expect(await saved()).toMatchObject({ revision:4,title:'Current authoring audit' });
    expect(await snapshots()).toHaveLength(1);
  });
  it.each(['publish','restore'] as const)('reports deletion between %s read and write as a conflict', async (action) => {
    client = databaseClient(owner, async () => { await admin.query('delete from public.workflow_canvases where id=$1',[canvasId]); });
    expect(await (action === 'publish' ? publish() : restore())).toMatchObject({ ok:false,status:409 });
    expect(await saved()).toBeUndefined();
    expect(await snapshots()).toHaveLength(0);
  });
  it.each(['publish','restore'] as const)('reports a rejected %s write without adding history', async (action) => {
    await admin.query(`create function public.audit_canvas_authoring_failure() returns trigger language plpgsql as $$
      begin if new.id='${canvasId}'::uuid then raise exception 'audit authoring write rejected'; end if; return new; end $$`);
    await admin.query('create trigger audit_canvas_authoring_failure before update on public.workflow_canvases for each row execute function public.audit_canvas_authoring_failure()');
    try {
      expect(await (action === 'publish' ? publish() : restore())).toMatchObject({ ok:false,status:500 });
      expect(await saved()).toMatchObject({ revision:4,title:'Current authoring audit' });
      expect(await snapshots()).toHaveLength(1);
    } finally {
      await admin.query('drop trigger audit_canvas_authoring_failure on public.workflow_canvases');
      await admin.query('drop function public.audit_canvas_authoring_failure()');
    }
  });
  it.each(['save','publish','restore'] as const)('rejects a title-only rename when %s commits after its read', async (action) => {
    let winningRow: Record<string, unknown> | undefined;
    const delayedRename = databaseClient(owner, async () => {
      const result = action === 'save' ? await save() : action === 'publish' ? await publish(databaseClient(other)) : await restore(databaseClient(other));
      expect(result).toMatchObject({ ok:true });
      winningRow = await saved();
    });
    expect.soft(await patchWorkflowCanvasForRoute({ canvasId,userId,supabase:delayedRename,body:{ title:'Delayed rename' } })).toMatchObject({ ok:false,status:409 });
    expect.soft(await saved()).toMatchObject({ revision:5,title:action === 'save' ? 'Newer saved title' : action === 'publish' ? 'Current authoring audit' : 'Historical title',status:action === 'publish' ? 'published' : 'draft' });
    expect(await saved()).toEqual(winningRow);
    expect(await snapshots()).toHaveLength(2);
  });
  it('publishes and restores sequentially with increasing revisions and persisted snapshots', async () => {
    expect(await publish()).toMatchObject({ ok:true,body:{ canvas:{ revision:5,status:'published' } } });
    expect(await restore()).toMatchObject({ ok:true,body:{ canvas:{ revision:6,status:'draft',title:'Historical title' } } });
    expect(await snapshots()).toEqual([
      { title:'Historical title',revision:2,kind:'draft' },
      { title:'Current authoring audit',revision:5,kind:'published' },
      { title:'Historical title',revision:6,kind:'draft' },
    ]);
  });
});
