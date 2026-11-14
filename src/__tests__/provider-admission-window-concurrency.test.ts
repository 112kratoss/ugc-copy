import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PROVIDER_ADMISSION_POLICY } from '@/lib/provider-admission';

/**
 * True-concurrency coverage for the provider rate window.
 *
 * pgTAP runs one transaction, so it can prove the window's arithmetic but not
 * the property the gate exists for: that callers arriving together on separate
 * connections are admitted up to the window's count and not one beyond it. A
 * window read without its row lock, or stamped before the lock was held, passes
 * every single-connection test and admits all of them here.
 */
const connectionString = process.env.SUPABASE_TEST_DB_URL;

const { rateWindowSeconds, rateWindowMax, modelRateWindowMax } = PROVIDER_ADMISSION_POLICY;

describe.skipIf(!connectionString)('provider rate window under concurrent callers', () => {
  const clients: Client[] = [];
  let admin: Client;
  let service: string;

  async function connect() {
    const client = new Client({ connectionString });
    await client.connect();
    clients.push(client);
    await client.query("set statement_timeout='15s'; set deadlock_timeout='100ms'");
    return client;
  }

  async function admitTogether(callers: number, model: string | null) {
    const connections = await Promise.all(Array.from({ length: callers }, () => connect()));
    const results = await Promise.all(connections.map((client) => client.query(
      `select public.admit_provider_submission(
         p_service => $1, p_model => $2, p_max_in_flight => 100000,
         p_rate_window_seconds => $3, p_rate_window_max => $4, p_model_rate_window_max => $5
       ) as verdict`,
      [service, model, rateWindowSeconds, rateWindowMax, model ? modelRateWindowMax : null],
    )));
    const reasons = results.map((result) => result.rows[0].verdict.reason as string);
    return {
      admitted: reasons.filter((reason) => reason === 'admitted').length,
      refused: reasons.filter((reason) => reason !== 'admitted'),
    };
  }

  async function stored(scope: string) {
    const { rows } = await admin.query(
      `select cardinality(admitted_at) as count,
              extract(epoch from (admitted_at[cardinality(admitted_at)] - admitted_at[1])) as spread
       from public.provider_admission_buckets where scope = $1`,
      [scope],
    );
    return rows[0] as { count: number; spread: string } | undefined;
  }

  beforeEach(async () => {
    expect(['127.0.0.1', 'localhost']).toContain(new URL(connectionString!).hostname);
    service = `vitest-window-${randomUUID()}`;
    admin = await connect();
  });

  afterEach(async () => {
    if (admin) {
      await admin.query('delete from public.provider_admission_buckets where scope = $1 or scope like $2', [service, `${service}:%`]);
      await admin.query('delete from public.provider_circuit_breakers where service = $1', [service]);
    }
    await Promise.all(clients.splice(0).map((client) => client.end()));
  });

  it('admits exactly the window from callers that arrive together', async () => {
    const callers = rateWindowMax + 12;
    const { admitted, refused } = await admitTogether(callers, null);

    expect(admitted).toBe(rateWindowMax);
    expect(refused).toHaveLength(callers - rateWindowMax);
    expect(new Set(refused)).toEqual(new Set(['rate_limited']));

    // Every admission is on the row, and they fit one window between them.
    const row = await stored(service);
    expect(row?.count).toBe(rateWindowMax);
    expect(Number(row?.spread)).toBeLessThan(rateWindowSeconds);
  });

  it('holds one model to its share and leaves the rest of the window to another', async () => {
    const first = await admitTogether(modelRateWindowMax + 10, 'popular');
    expect(first.admitted).toBe(modelRateWindowMax);
    expect(new Set(first.refused)).toEqual(new Set(['model_rate_limited']));

    const left = rateWindowMax - modelRateWindowMax;
    const second = await admitTogether(left + 4, 'other');
    expect(second.admitted).toBe(left);
    expect(new Set(second.refused)).toEqual(new Set(['rate_limited']));

    expect((await stored(service))?.count).toBe(rateWindowMax);
    expect((await stored(`${service}:popular`))?.count).toBe(modelRateWindowMax);
    expect((await stored(`${service}:other`))?.count).toBe(left);
  });

  it('never has two candidates for one call, old arguments or new', async () => {
    // PostgREST refuses an ambiguous call, and the app admits on an RPC error:
    // an overload left beside the new function would switch the gate off.
    const { rows } = await admin.query(
      `select p.proname, count(*)::int as candidates,
              bool_or(has_function_privilege('anon', p.oid, 'execute')) as anon,
              bool_or(has_function_privilege('authenticated', p.oid, 'execute')) as authenticated,
              bool_and(has_function_privilege('service_role', p.oid, 'execute')) as service_role
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('admit_provider_submission', 'reserve_provider_submission')
       group by p.proname order by p.proname`,
    );

    expect(rows).toEqual([
      { proname: 'admit_provider_submission', candidates: 1, anon: false, authenticated: false, service_role: true },
      { proname: 'reserve_provider_submission', candidates: 1, anon: false, authenticated: false, service_role: true },
    ]);
  });
});
