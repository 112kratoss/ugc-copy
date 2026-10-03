import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';

import { validateAndCompileTemplateGraph } from '@/lib/template-graph-compiler';
import { createTemplateReadyStarterGraph } from '@/lib/workflow-canvas';

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
/** Functions that return rows and are read as a table. Every other one returns a single value. */
const ROW_FUNCTIONS = new Set(['claim_template_run_jobs']);

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

/** PostgREST hands a timestamp over as text, where the driver would make a Date of it. */
function asPostgrestRow(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value instanceof Date ? value.toISOString() : value,
  ]));
}

/**
 * The PostgREST calls the run worker, the start service and the job queue
 * make, over one connection to a real database.
 *
 * `template-run-step-busy-retry-database.test.ts` carries the harness this
 * grew from inline. This one differs where PostgREST does: it hands
 * timestamps over as text, and it honours a `select` list, so a column the
 * table does not have fails a test as it would fail in production.
 *
 * `startAnswers` collects what `start_template_generation` answered, in order:
 * a status, or the database error.
 */
export function createTemplateRunPostgresClient(db: Client, startAnswers: string[] = []): SupabaseClient {
  return {
    from(table: string) {
      identifier(table);
      const filters: string[] = [];
      const values: unknown[] = [];
      const orders: string[] = [];
      // A column the table does not have is refused here as PostgREST refuses it.
      let columns = '*';
      let limit: number | null = null;
      let insert: Record<string, unknown> | null = null;
      let update: Record<string, unknown> | null = null;

      const run = async () => {
        if (insert) {
          const keys = Object.keys(insert).map(identifier);
          return (await db.query(
            `insert into public.${table}(${keys.join(',')}) values(${keys.map((_, index) => `$${index + 1}`).join(',')}) returning ${columns}`,
            Object.values(insert).map(writable),
          )).rows;
        }
        if (!filters.length) throw new Error(`Unbounded query on ${table}`);
        const where = ` where ${filters.join(' and ')}`;
        if (update) {
          const keys = Object.keys(update).map(identifier);
          return (await db.query(
            `update public.${table} set ${keys.map((key, index) => `${key}=$${values.length + index + 1}`).join(',')}${where} returning ${columns}`,
            [...values, ...Object.values(update).map(writable)],
          )).rows;
        }
        return (await db.query(
          `select ${columns} from public.${table}${where}${orders.length ? ` order by ${orders.join(',')}` : ''}${limit === null ? '' : ` limit ${limit}`}`,
          values,
        )).rows;
      };
      const answer = async (single: boolean, required: boolean) => {
        try {
          const rows = (await run()).map(asPostgrestRow);
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
        select(selected?: string) {
          if (selected && selected.trim() !== '*') {
            columns = selected.split(',').map((column) => identifier(column.trim())).join(',');
          }
          return query;
        },
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
        lt: compare('<'),
        in(column: string, value: unknown[]) {
          values.push(value);
          filters.push(`${identifier(column)}=any($${values.length})`);
          return query;
        },
        order(column: string, options?: { ascending?: boolean }) {
          orders.push(`${identifier(column)} ${options?.ascending === false ? 'desc' : 'asc'}`);
          return query;
        },
        limit(count: number) {
          limit = Math.trunc(count);
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
        if (name === 'start_template_generation') startAnswers.push(data.status);
        return { data, error: null };
      } catch (error) {
        if (name === 'start_template_generation') startAnswers.push(databaseError(error).message);
        return { data: null, error: databaseError(error) };
      }
    },
    storage: {
      from: () => ({
        remove: async () => ({ error: null }),
        download: async () => ({ data: null, error: null }),
        createSignedUrls: async (paths: string[]) => ({
          data: paths.map((path) => ({ path, signedUrl: `https://storage.test/${path}`, error: null })),
          error: null,
        }),
      }),
    },
  } as unknown as SupabaseClient;
}

export type StarterTemplateRun = { userId: string; templateId: string; runId: string };

/**
 * A person with credits and a queued run of the starter template: two image
 * steps the worker starts in one pass, then the approvals and the video step
 * that wait on them.
 */
export async function seedStarterTemplateRun(
  admin: Client,
  options: { credits: number; title: string },
): Promise<StarterTemplateRun> {
  const userId = randomUUID();
  await admin.query(
    "insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())",
    [userId, `${userId}@example.invalid`],
  );
  await admin.query('update public.profiles set credits=$2,promotional_credits=0 where id=$1', [userId, options.credits]);
  await admin.query(
    'insert into public.mobile_notification_preferences(user_id,push_enabled) values($1,false) on conflict(user_id) do update set push_enabled=false',
    [userId],
  );

  const graph = createTemplateReadyStarterGraph();
  const output = graph.nodes.find((node) => node.type === 'video-generate')!;
  const { compiled } = validateAndCompileTemplateGraph({
    graph, outputNodeId: output.id, canvasRevision: 3, catalogRevision: null,
  });
  if (!compiled) throw new Error('Starter graph must compile.');
  // A run of the creator's own draft, as the publish drawer's test run is:
  // it has no published version, and a published version can never be
  // deleted again, so a fixture with one would stay in the database.
  const templateId = randomUUID();
  await admin.query(
    "insert into public.templates(id,name,creator_user_id,status,is_active) values($1,$2,$3,'draft',true)",
    [templateId, options.title, userId],
  );
  const runId = randomUUID();
  const snapshot = {
    ...compiled,
    catalogRevision: 'catalog-rev-1',
    templateId,
    templateVersionId: null,
    templateTitle: options.title,
    sourceCanvasId: null,
    sourceCanvasRevision: 3,
    demoOutputUrl: null,
  };
  const inputPaths = Object.fromEntries(compiled.inputSlots.map((slot) => [
    slot.key,
    `template_inputs/${userId}/${runId}/final/${slot.key}/input.png`,
  ]));
  await admin.query(
    `insert into public.template_runs(id,template_id,user_id,graph_snapshot,graph_hash,input_manifest,input_storage_paths,output_node_id,output_kind,status,estimated_total_credits,estimated_remaining_credits,is_test,catalog_revision)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,$10,true,'catalog-rev-1')`,
    [runId, templateId, userId, JSON.stringify(snapshot), compiled.graphHash, JSON.stringify(compiled.inputSlots), JSON.stringify(inputPaths), compiled.outputNodeId, compiled.outputKind, compiled.estimatedTotalCredits],
  );
  const nodes = (compiled.graph as { nodes?: Array<{ id: string; type: string; data: { title?: string } }> }).nodes ?? [];
  for (const node of nodes.filter((candidate) => ['image-generate', 'video-generate', 'approval-gate'].includes(candidate.type))) {
    await admin.query(
      `insert into public.template_run_steps(run_id,node_id,kind,media_kind,label,status,estimated_credits)
       values($1,$2,$3,$4,$5,'queued',$6)`,
      [runId, node.id, node.type === 'approval-gate' ? 'approval' : 'generation', node.type === 'video-generate' ? 'video' : 'image', node.data.title ?? node.id, compiled.nodeCosts[node.id] ?? 0],
    );
  }

  return { userId, templateId, runId };
}

export async function removeStarterTemplateRun(admin: Client, seed: StarterTemplateRun) {
  await admin.query('delete from public.generations where user_id=$1', [seed.userId]);
  await admin.query('delete from public.template_runs where id=$1', [seed.runId]);
  await admin.query('delete from public.templates where id=$1', [seed.templateId]);
  await admin.query('delete from auth.users where id=$1', [seed.userId]);
}
