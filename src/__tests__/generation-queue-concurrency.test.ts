import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * True-concurrency coverage for the queue of generation starts.
 *
 * Several things drive a queued run at once: the request that queued it, the
 * creator's status checks, the provider's callback, a cron. pgTAP proves the
 * claim hands a request out once when it is asked twice in a row. What makes
 * a queued run safe is that it is handed out once when it is asked for by
 * eight connections in the same instant, and that the queue's length holds
 * when a crowd joins it together.
 */
const connectionString = process.env.SUPABASE_TEST_DB_URL;

const WINDOW = 3;

describe.skipIf(!connectionString)('the generation queue under concurrent callers', () => {
  const clients: Client[] = [];
  let admin: Client;
  let service: string;
  let users: string[] = [];

  async function connect() {
    const client = new Client({ connectionString });
    await client.connect();
    clients.push(client);
    await client.query("set statement_timeout='15s'; set deadlock_timeout='100ms'");
    return client;
  }

  async function creator() {
    const user = randomUUID();
    users.push(user);
    await admin.query(
      "insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)"
        + " values ($1::uuid, $1::text || '@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now())",
      [user],
    );
    return user;
  }

  async function generations(user: string, count: number) {
    const ids = Array.from({ length: count }, () => randomUUID());
    await admin.query(
      "insert into public.generations (id, user_id, model, status, category, prompt)"
        + " select id, $2::uuid, 'queue-test', 'pending', 'image', 'queue fixture' from unnest($1::uuid[]) as id",
      [ids, user],
    );
    return ids;
  }

  async function enqueue(client: Client, generationId: string, queueMax = 200, userMax = 200) {
    const { rows } = await client.query(
      "select public.enqueue_provider_submission($1::uuid, $2, null, 'https://api.kie.ai/api/v1/jobs/createTask',"
        + " jsonb_build_object('model', 'queue-test', 'input', jsonb_build_object('prompt', $1::text)), $3, $4) as answer",
      [generationId, service, queueMax, userMax],
    );
    return rows[0].answer as { status: string; queuedAt?: string };
  }

  /**
   * What a pass over the queue does for one run: ask for its turn, and claim
   * its request if it has it. The gate reads the run's turn from its own row.
   */
  async function drive(client: Client, generationId: string) {
    const { rows: [asked] } = await client.query(
      "select public.reserve_provider_submission($1::uuid, $2, null,"
        + " p_max_in_flight => 100000, p_rate_window_seconds => 12, p_rate_window_max => $3) as verdict",
      [generationId, service, WINDOW],
    );
    if (asked.verdict.allowed !== true) return null;
    const { rows: [claimed] } = await client.query(
      'select public.claim_queued_provider_submission($1::uuid) as request',
      [generationId],
    );
    return claimed.request as { request: { input: { prompt: string } } } | null;
  }

  beforeEach(async () => {
    expect(['127.0.0.1', 'localhost']).toContain(new URL(connectionString!).hostname);
    service = `vitest-queue-${randomUUID()}`;
    users = [];
    admin = await connect();
  });

  afterEach(async () => {
    if (admin) {
      await admin.query('delete from public.generations where user_id = any($1::uuid[])', [users]);
      await admin.query('delete from auth.users where id = any($1::uuid[])', [users]);
      await admin.query('delete from public.generation_queued_submissions where service = $1', [service]);
      await admin.query('delete from public.provider_admission_buckets where scope = $1', [service]);
      await admin.query('delete from public.provider_circuit_breakers where service = $1', [service]);
    }
    await Promise.all(clients.splice(0).map((client) => client.end()));
  });

  it('hands a queued run\'s request to exactly one of eight drivers that ask together', async () => {
    const [id] = await generations(await creator(), 1);
    const queued = await enqueue(admin, id);
    expect(queued.status).toBe('queued');

    const drivers = await Promise.all(Array.from({ length: 8 }, () => connect()));
    const claims = await Promise.all(drivers.map((client) => drive(client, id)));

    // One driver holds the request and sends the run. The other seven were
    // admitted too (the run has one place, which is the run's, not theirs)
    // and found nothing to claim.
    const held = claims.filter((claim) => claim !== null);
    expect(held).toHaveLength(1);
    expect(held[0]!.request.input.prompt).toBe(id);

    const { rows: [after] } = await admin.query(
      'select'
        + ' (select count(*)::int from public.generation_queued_submissions where generation_id = $1) as queued,'
        + ' (select cardinality(admitted_at) from public.provider_admission_buckets where scope = $2) as places_taken,'
        + ' (select provider_submission_reserved_at is not null from public.generations where id = $1) as reserved',
      [id, service],
    );
    // Eight asks, one place in the rate window: the run is one submission.
    expect(after).toEqual({ queued: 0, places_taken: 1, reserved: true });
  });

  it('sends queued runs in the order they were queued, whoever drives first', async () => {
    const user = await creator();
    const filling = await generations(user, WINDOW);
    const waiting = await generations(user, 6);

    // The rate window fills, so the next six are queued, one after another.
    for (const id of filling) {
      const { rows: [row] } = await admin.query(
        'select public.reserve_provider_submission($1::uuid, $2, null, p_max_in_flight => 100000, p_rate_window_max => $3) as verdict',
        [id, service, WINDOW],
      );
      expect(row.verdict.allowed).toBe(true);
    }
    for (const id of waiting) {
      expect((await enqueue(admin, id)).status).toBe('queued');
    }

    // The window opens and all six are asked for at once, in whatever order
    // the connections reach the database. Nothing has been asking for any of
    // them: each has only its place in the queue to say whose turn it is.
    await admin.query("update public.provider_admission_buckets set admitted_at = '{}' where scope = $1", [service]);
    const drivers = await Promise.all(waiting.map(() => connect()));
    const claims = await Promise.all(waiting.map((id, index) => drive(drivers[index], id)));

    expect(waiting.filter((_, index) => claims[index] !== null)).toEqual(waiting.slice(0, WINDOW));

    await admin.query("update public.provider_admission_buckets set admitted_at = '{}' where scope = $1", [service]);
    const rest = await Promise.all(waiting.map((id, index) => (
      claims[index] === null ? drive(drivers[index], id) : null
    )));
    expect(waiting.filter((_, index) => rest[index] !== null)).toEqual(waiting.slice(WINDOW));
  });

  it('does not let a new start walk past a queue nobody is serving', async () => {
    const user = await creator();
    const [first, queuedRun, ...newcomers] = await generations(user, 8);
    const admit = (client: Client, id: string) => client.query(
      'select public.reserve_provider_submission($1::uuid, $2, null, p_max_in_flight => 100000, p_rate_window_max => 1) as verdict',
      [id, service],
    ).then(({ rows }) => rows[0].verdict as { allowed: boolean; reason: string });

    expect((await admit(admin, first)).allowed).toBe(true);
    expect((await enqueue(admin, queuedRun)).status).toBe('queued');
    await admin.query("update public.provider_admission_buckets set admitted_at = '{}' where scope = $1", [service]);

    // One place is open, the queued run is waiting for it, and six new starts
    // arrive together before anything has asked for the queued run.
    const connections = await Promise.all(newcomers.map(() => connect()));
    const verdicts = await Promise.all(newcomers.map((id, index) => admit(connections[index], id)));

    expect(verdicts.filter((verdict) => verdict.allowed)).toEqual([]);
    expect((await admit(admin, queuedRun)).allowed).toBe(true);
  });

  it('holds the queue to its length, and each creator to their share, when a crowd joins together', async () => {
    const QUEUE_MAX = 5;
    const USER_MAX = 2;
    const crowd = await Promise.all(Array.from({ length: 6 }, () => creator()));
    const ids = (await Promise.all(crowd.map((user) => generations(user, 3)))).flat();
    const connections = await Promise.all(ids.map(() => connect()));

    const answers = await Promise.all(ids.map((id, index) => enqueue(connections[index], id, QUEUE_MAX, USER_MAX)));

    expect(answers.filter((answer) => answer.status === 'queued')).toHaveLength(QUEUE_MAX);
    const { rows } = await admin.query(
      'select count(*)::int as queued, max(per_user)::int as most_of_one from ('
        + ' select count(*) as per_user from public.generation_queued_submissions where service = $1 group by user_id'
        + ') shares',
      [service],
    );
    const { rows: [total] } = await admin.query(
      'select count(*)::int as queued from public.generation_queued_submissions where service = $1',
      [service],
    );
    expect(total.queued).toBe(QUEUE_MAX);
    expect(rows[0].most_of_one).toBeLessThanOrEqual(USER_MAX);
    for (const answer of answers) {
      expect(['queued', 'queue_full', 'user_queue_full']).toContain(answer.status);
    }
  });
});
