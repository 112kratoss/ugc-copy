import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyWorkflowAssistantProposalForRoute } from '@/lib/workflow-assistant-proposal-apply-service';
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

/** Execute the assistant services' query shapes using real SQL and the connection's role. */
function databaseClient(
  db: Client,
  beforeWrite?: () => Promise<void>,
  rpcHooks: { before?: () => Promise<void>; after?: () => Promise<void> } = {},
): SupabaseClient {
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
        await rpcHooks.before?.();
        const { rows } = await db.query(
          ROW_FUNCTIONS.has(name) ? `select * from ${call}` : `select ${call} as result`,
          Object.values(args).map(writable),
        );
        const data = ROW_FUNCTIONS.has(name) ? rows : rows[0].result;
        await rpcHooks.after?.();
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
  const applyService = () => applyWorkflowAssistantProposalForRoute({ canvasId, proposalId, userId, supabase: client });
  const canvas = async () => (await admin.query('select graph,viewport,revision,status from public.workflow_canvases where id=$1', [canvasId])).rows[0];
  const history = async () => (await admin.query('select graph,revision from public.workflow_canvas_history where canvas_id=$1', [canvasId])).rows;
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
  it('rejects stale apply without overwriting newer canvas content', async () => {
    await admin.query("update public.workflow_canvases set revision=5,title='Newer edit' where id=$1",[canvasId]);
    expect(await apply()).toBe('conflict');
    expect((await admin.query('select revision,title from public.workflow_canvases where id=$1',[canvasId])).rows[0]).toEqual({ revision:5,title:'Newer edit' });
    expect(await saved()).toMatchObject({ status:'discarded',applied_at:null });
  });
  it('rolls graph and proposal back if writing apply history fails', async () => {
    const before = await canvas();
    await admin.query(`create function public.audit_apply_history_failure() returns trigger language plpgsql as $$
      begin if new.canvas_id='${canvasId}'::uuid then raise exception 'audit history rejected'; end if; return new; end $$`);
    await admin.query('create trigger audit_apply_history_failure before insert on public.workflow_canvas_history for each row execute function public.audit_apply_history_failure()');
    try {
      const result = await databaseClient(other).rpc('apply_workflow_canvas_assistant_proposal',{ p_canvas_id:canvasId,p_proposal_id:proposalId,p_merged_graph:{ ...graph,viewport:{ x:125,y:50,zoom:1 } } });
      expect(result.error?.message).toBe('audit history rejected');
      expect(await canvas()).toEqual(before);
      expect(await history()).toEqual([]);
      expect((await admin.query('select revision from public.workflow_canvases where id=$1',[canvasId])).rows[0].revision).toBe(4);
      expect(await saved()).toMatchObject({ status:'ready',applied_at:null });
    } finally {
      await admin.query('drop trigger audit_apply_history_failure on public.workflow_canvas_history');
      await admin.query('drop function public.audit_apply_history_failure()');
    }
    expect(await apply()).toBe('applied');
  });
  it('serializes different ready proposals sharing one base revision', async () => {
    const second = randomUUID();
    await admin.query("insert into public.workflow_canvas_assistant_proposals(id,canvas_id,user_id,base_revision,status,summary,diff,proposed_graph) values($1,$2,$3,4,'ready','Other proposal','{}'::jsonb,$4)",[second,canvasId,userId,JSON.stringify(graph)]);
    const results = await Promise.all([
      databaseClient(owner).rpc('apply_workflow_canvas_assistant_proposal',{ p_canvas_id:canvasId,p_proposal_id:proposalId,p_merged_graph:{ ...graph,viewport:{ x:125,y:50,zoom:1 } } }),
      databaseClient(other).rpc('apply_workflow_canvas_assistant_proposal',{ p_canvas_id:canvasId,p_proposal_id:second,p_merged_graph:{ ...graph,viewport:{ x:250,y:100,zoom:1 } } }),
    ]);
    expect(results.every(row=>row.error===null)).toBe(true);
    expect(results.map(row=>row.data.outcome).sort()).toEqual(['applied','conflict']);
    expect((await admin.query('select revision from public.workflow_canvases where id=$1',[canvasId])).rows[0].revision).toBe(5);
    expect((await admin.query('select id from public.workflow_canvas_history where canvas_id=$1',[canvasId])).rows).toHaveLength(1);
  });
  it('applies the service-normalized graph, publication state and history together', async () => {
    const proposed = { ...graph, viewport: { x: 250, y: 100, zoom: 1 } };
    await admin.query("update public.workflow_canvases set status='published',published_at=now() where id=$1", [canvasId]);
    await admin.query('update public.workflow_canvas_assistant_proposals set proposed_graph=$2 where id=$1', [proposalId, JSON.stringify(proposed)]);
    expect(await applyService()).toMatchObject({ ok: true, body: { canvas: { revision: 5, status: 'draft' }, proposal: { status: 'applied' } } });
    const persisted = await canvas();
    expect(persisted.viewport).toEqual(proposed.viewport);
    expect(persisted.graph.viewport).toEqual(proposed.viewport);
    expect(await history()).toEqual([{ graph: persisted.graph, revision: 5 }]);
    const first = await saved();
    expect(first.applied_at).not.toBeNull();
    expect(await applyService()).toMatchObject({ ok: false, status: 409 });
    expect(await saved()).toEqual(first);
    expect(await history()).toHaveLength(1);
  });
  it('rejects a save committed after service reads without replacing the newer graph', async () => {
    const newer = { ...graph, viewport: { x: 800, y: 300, zoom: 2 } };
    client = databaseClient(owner, undefined, { before: async () => {
      await admin.query('update public.workflow_canvases set graph=$2,revision=5 where id=$1', [canvasId, JSON.stringify(newer)]);
    } });
    expect(await applyService()).toMatchObject({ ok: false, status: 409, body: { canvas: { revision: 5 } } });
    expect(await canvas()).toMatchObject({ graph: JSON.parse(JSON.stringify(newer)), revision: 5 });
    expect(await saved()).toMatchObject({ status: 'discarded', applied_at: null });
    expect(await history()).toEqual([]);
  });
  it('does not apply twice after the committed SQL acknowledgement is lost', async () => {
    await admin.query('update public.workflow_canvas_assistant_proposals set proposed_graph=$2 where id=$1', [proposalId, JSON.stringify({ ...graph, viewport: { x: 250, y: 100, zoom: 1 } })]);
    client = databaseClient(owner, undefined, { after: async () => {
      // Independent connection observes the commit before the response is lost.
      expect(await saved()).toMatchObject({ status: 'applied' });
      expect((await canvas()).revision).toBe(5);
      throw new Error('audit SQL acknowledgement lost');
    } });
    expect(await applyService()).toMatchObject({ ok: false, status: 500 });
    const committed = await canvas();
    const firstProposal = await saved();
    client = databaseClient(owner);
    expect(await applyService()).toMatchObject({ ok: false, status: 409 });
    expect(await canvas()).toEqual(committed);
    expect(await saved()).toEqual(firstProposal);
    expect(await history()).toHaveLength(1);
  });
  it('serializes two direct requests for the same proposal into one application', async () => {
    const args = { p_canvas_id: canvasId, p_proposal_id: proposalId, p_merged_graph: { ...graph, viewport: { x: 125, y: 50, zoom: 1 } } };
    const results = await Promise.all([
      databaseClient(owner).rpc('apply_workflow_canvas_assistant_proposal', args),
      databaseClient(other).rpc('apply_workflow_canvas_assistant_proposal', args),
    ]);
    expect(results.every(result => result.error === null)).toBe(true);
    expect(results.map(result => result.data.outcome).sort()).toEqual(['applied', 'proposal_not_ready']);
    expect((await canvas()).revision).toBe(5);
    expect(await history()).toHaveLength(1);
  });
  it('denies another authenticated identity at both service and direct SQL boundaries', async () => {
    await owner.query("select set_config('request.jwt.claim.sub',$1,false)", [randomUUID()]);
    expect(await applyService()).toMatchObject({ ok: false, status: 404 });
    const direct = await client.rpc('apply_workflow_canvas_assistant_proposal', { p_canvas_id: canvasId, p_proposal_id: proposalId, p_merged_graph: graph });
    expect(direct.error).toBeNull();
    expect(direct.data).toEqual({ outcome: 'not_found' });
    expect(await saved()).toMatchObject({ status: 'ready', applied_at: null });
    expect((await canvas()).revision).toBe(4);
    expect(await history()).toEqual([]);
  });
  it('denies an anonymous direct SQL apply even with an owner subject claim', async () => {
    await owner.query('set role anon');
    try {
      const result = await client.rpc('apply_workflow_canvas_assistant_proposal', { p_canvas_id: canvasId, p_proposal_id: proposalId, p_merged_graph: graph });
      expect(result.error?.code).toBe('42501');
      expect(await saved()).toMatchObject({ status: 'ready', applied_at: null });
      expect((await canvas()).revision).toBe(4);
    } finally {
      await owner.query('set role authenticated');
    }
  });
  it('marks an unchanged graph applied without creating a fake revision or history entry', async () => {
    const before = await canvas();
    const result = await client.rpc('apply_workflow_canvas_assistant_proposal', { p_canvas_id: canvasId, p_proposal_id: proposalId, p_merged_graph: before.graph });
    expect(result.error).toBeNull();
    expect(result.data.outcome).toBe('applied');
    expect(await canvas()).toEqual(before);
    expect(await history()).toEqual([]);
    expect(await saved()).toMatchObject({ status: 'applied', discarded_at: null });
  });
  it('discards a ready proposal and prevents its later application', async () => {
    expect(await discard()).toMatchObject({ ok:true });
    expect(await saved()).toMatchObject({ status:'discarded',applied_at:null });
    expect(await apply()).toBe('proposal_not_ready');
  });
});
