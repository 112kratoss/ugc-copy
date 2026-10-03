import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { discardWorkflowAssistantProposalForRoute } from '@/lib/workflow-assistant-proposal-discard-service';
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

/** The PostgREST calls the run worker, the start service and the job queue make, over one connection. */
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

describe.skipIf(!connectionString)('assistant proposal transitions with actual authenticated SQL', () => {
  let admin: Client;
  let owner: Client;
  let other: Client;
  let userId: string;
  let canvasId: string;
  let proposalId: string;
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
    userId = randomUUID(); canvasId = randomUUID(); proposalId = randomUUID();
    await admin.query("insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())", [userId, `${userId}@example.invalid`]);
    await owner.query("select set_config('request.jwt.claim.sub',$1,false)", [userId]);
    await other.query("select set_config('request.jwt.claim.sub',$1,false)", [userId]);
    await admin.query("insert into public.workflow_canvases(id,user_id,title,graph,revision) values($1,$2,'Assistant transition audit',$3,4)", [canvasId,userId,JSON.stringify(graph)]);
    await admin.query("insert into public.workflow_canvas_assistant_proposals(id,canvas_id,user_id,base_revision,status,summary,diff,proposed_graph) values($1,$2,$3,4,'ready','Audit proposal','{}'::jsonb,$4)", [proposalId,canvasId,userId,JSON.stringify(graph)]);
    client = databaseClient(owner);
  });
  afterEach(async () => {
    await admin.query('delete from public.workflow_canvases where id=$1', [canvasId]);
    await admin.query('delete from auth.users where id=$1', [userId]);
  });
  const discard = () => discardWorkflowAssistantProposalForRoute({ canvasId,proposalId,userId,supabase:client });
  const saved = async () => (await admin.query('select status,applied_at,discarded_at from public.workflow_canvas_assistant_proposals where id=$1',[proposalId])).rows[0];
  async function apply() {
    const result = await databaseClient(other).rpc('apply_workflow_canvas_assistant_proposal', { p_canvas_id:canvasId,p_proposal_id:proposalId,p_merged_graph:{ ...graph, viewport:{ x:125,y:50,zoom:1 } } });
    expect(result.error).toBeNull();
    return result.data.outcome;
  }
  it('does not discard a proposal that has already been applied', async () => {
    expect(await apply()).toBe('applied');
    expect(await discard()).toMatchObject({ ok:false,status:409 });
    expect(await saved()).toMatchObject({ status:'applied',discarded_at:null });
    expect((await admin.query('select revision from public.workflow_canvases where id=$1',[canvasId])).rows[0].revision).toBe(5);
  });
  it('does not overwrite an apply that commits after the discard read', async () => {
    client = databaseClient(owner, async () => { expect(await apply()).toBe('applied'); });
    expect(await discard()).toMatchObject({ ok:false,status:409 });
    expect(await saved()).toMatchObject({ status:'applied',discarded_at:null });
    expect((await admin.query('select revision from public.workflow_canvases where id=$1',[canvasId])).rows[0].revision).toBe(5);
  });
  it('reports a real rejected discard write as a failure', async () => {
    await admin.query(`create function public.audit_discard_failure() returns trigger language plpgsql as $$
      begin if new.id='${proposalId}'::uuid then raise exception 'audit discard rejected'; end if; return new; end $$`);
    await admin.query('create trigger audit_discard_failure before update on public.workflow_canvas_assistant_proposals for each row execute function public.audit_discard_failure()');
    try {
      expect(await discard()).toMatchObject({ ok:false,status:500 });
      expect(await saved()).toMatchObject({ status:'ready',discarded_at:null });
    } finally {
      await admin.query('drop trigger audit_discard_failure on public.workflow_canvas_assistant_proposals');
      await admin.query('drop function public.audit_discard_failure()');
    }
  });
  it('does not report success if the proposal disappears between read and write', async () => {
    client = databaseClient(owner, async () => { await admin.query('delete from public.workflow_canvas_assistant_proposals where id=$1',[proposalId]); });
    expect(await discard()).toMatchObject({ ok:false,status:409 });
    expect(await saved()).toBeUndefined();
  });
  it('preserves the first discard timestamp on duplicate requests', async () => {
    expect(await discard()).toMatchObject({ ok:true });
    const first = await saved();
    expect(await discard()).toMatchObject({ ok:false,status:409 });
    expect(await saved()).toEqual(first);
  });
  it('rejects another authenticated identity even if it supplies the owner ID', async () => {
    await owner.query("select set_config('request.jwt.claim.sub',$1,false)",[randomUUID()]);
    expect(await discard()).toMatchObject({ ok:false,status:404 });
    expect(await saved()).toMatchObject({ status:'ready',discarded_at:null });
  });
  it('discards a ready proposal and prevents its later application', async () => {
    expect(await discard()).toMatchObject({ ok:true });
    expect(await saved()).toMatchObject({ status:'discarded',applied_at:null });
    expect(await apply()).toBe('proposal_not_ready');
  });
});
