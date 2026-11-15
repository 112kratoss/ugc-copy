import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * True-concurrency coverage for the waiting line's tickets.
 *
 * Since the queue (generation-queue-concurrency.test.ts) nothing in the app
 * takes a ticket: a start over the limits is queued, and the queue's rows are
 * the line. The tickets are still honoured by the reservation, for the
 * deployment before the queue, which waits inside its requests, until it can
 * no longer be rolled back to.
 *
 * pgTAP proves the line's rules one ask at a time. What makes it a queue is
 * that the rules hold when everybody asks at once: a place that opens must go
 * to the starts that waited longest whichever connection reaches the database
 * first. Without the line that order is whatever the lock queue happens to be.
 */
const connectionString = process.env.SUPABASE_TEST_DB_URL;

const WINDOW = 3;

describe.skipIf(!connectionString)('the waiting line under concurrent callers', () => {
  const clients: Client[] = [];
  let admin: Client;
  let service: string;
  let user: string;

  async function connect() {
    const client = new Client({ connectionString });
    await client.connect();
    clients.push(client);
    await client.query("set statement_timeout='15s'; set deadlock_timeout='100ms'");
    return client;
  }

  async function generations(count: number) {
    const ids = Array.from({ length: count }, () => randomUUID());
    await admin.query(
      `insert into public.generations (id, user_id, model, status, category, prompt)
       select id, $2::uuid, 'line-test', 'pending', 'image', 'waiting line fixture'
       from unnest($1::uuid[]) as id`,
      [ids, user],
    );
    return ids;
  }

  async function ask(client: Client, generationId: string, waits = true) {
    const { rows } = await client.query(
      `select public.reserve_provider_submission(
         $1::uuid, $2, null,
         p_max_in_flight => 100000, p_rate_window_seconds => 12, p_rate_window_max => $3, p_wait => $4
       ) as verdict`,
      [generationId, service, WINDOW, waits],
    );
    return rows[0].verdict as { allowed: boolean; reason: string; waiting: boolean; waitersAhead: number };
  }

  async function openTheWindow() {
    await admin.query(`update public.provider_admission_buckets set admitted_at = '{}' where scope = $1`, [service]);
  }

  beforeEach(async () => {
    expect(['127.0.0.1', 'localhost']).toContain(new URL(connectionString!).hostname);
    service = `vitest-line-${randomUUID()}`;
    user = randomUUID();
    admin = await connect();
    await admin.query(
      `insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
       values ($1::uuid, $1::text || '@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now())`,
      [user],
    );
  });

  afterEach(async () => {
    if (admin) {
      await admin.query('delete from public.generations where user_id = $1', [user]);
      await admin.query('delete from auth.users where id = $1', [user]);
      await admin.query('delete from public.provider_admission_buckets where scope = $1', [service]);
      await admin.query('delete from public.provider_circuit_breakers where service = $1', [service]);
    }
    await Promise.all(clients.splice(0).map((client) => client.end()));
  });

  it('gives the places that open to the starts that waited longest, whoever asks first', async () => {
    const [first, ...rest] = [await generations(WINDOW), await generations(6), await generations(3)];
    const [waiters, newcomers] = rest;

    // The window fills.
    for (const id of first) expect((await ask(admin, id)).reason).toBe('admitted');
    // Six starts arrive after it, one at a time, and take their tickets in that order.
    for (const id of waiters) expect(await ask(admin, id)).toMatchObject({ allowed: false, waiting: true });

    // The window opens, and all six ask at once, with three newcomers among them.
    await openTheWindow();
    const callers = [...waiters, ...newcomers];
    const connections = await Promise.all(callers.map(() => connect()));
    const verdicts = await Promise.all(callers.map((id, index) => ask(connections[index], id)));
    const admitted = callers.filter((_, index) => verdicts[index].allowed);

    expect(admitted).toEqual(waiters.slice(0, WINDOW));
    expect(verdicts.filter((verdict) => !verdict.allowed).map((verdict) => verdict.reason))
      .toEqual(Array(callers.length - WINDOW).fill('rate_limited'));

    // The next opening serves the next three in line, and only then the newcomers.
    await openTheWindow();
    const second = await Promise.all(callers.map((id, index) => (
      verdicts[index].allowed ? null : ask(connections[index], id)
    )));
    expect(callers.filter((_, index) => second[index]?.allowed)).toEqual(waiters.slice(WINDOW));

    await openTheWindow();
    const third = await Promise.all(newcomers.map((id, index) => ask(connections[waiters.length + index], id)));
    expect(third.map((verdict) => verdict.reason)).toEqual(['admitted', 'admitted', 'admitted']);

    const { rows } = await admin.query(
      `select count(*)::int as tickets from public.provider_submission_waiters where service = $1`,
      [service],
    );
    expect(rows[0].tickets).toBe(0);
  });

  it('never admits more than the window, with or without tickets', async () => {
    const ids = await generations(WINDOW + 9);
    const connections = await Promise.all(ids.map(() => connect()));

    const verdicts = await Promise.all(ids.map((id, index) => ask(connections[index], id, index % 2 === 0)));

    expect(verdicts.filter((verdict) => verdict.allowed)).toHaveLength(WINDOW);
    const { rows } = await admin.query(
      `select cardinality(admitted_at) as stamps from public.provider_admission_buckets where scope = $1`,
      [service],
    );
    expect(rows[0].stamps).toBe(WINDOW);
    // Only the refused starts that asked to wait hold a ticket.
    const refusedWaiting = verdicts.filter((verdict, index) => !verdict.allowed && index % 2 === 0).length;
    const tickets = await admin.query(
      `select count(*)::int as tickets from public.provider_submission_waiters where service = $1`,
      [service],
    );
    expect(tickets.rows[0].tickets).toBe(refusedWaiting);
  });
});
