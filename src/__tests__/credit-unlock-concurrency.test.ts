import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * True-concurrency coverage for credit-funded unlocks.
 *
 * Every credit-moving RPC already has sequential replay coverage in pgTAP: call
 * it twice in a row and the buyer is charged once. That is not the same
 * property as two genuinely simultaneous callers, and pgTAP structurally cannot
 * express it — it runs an entire test file inside one transaction, so it can
 * never hold two open at the same time.
 *
 * The race that matters in production: a user taps unlock on their phone and
 * their laptop within the same few milliseconds. Two transactions open, both
 * read "not yet unlocked", and unless the RPC takes a row lock before deciding,
 * both proceed — charging twice for one entitlement.
 *
 * This suite drives that directly, over N independent Postgres connections
 * against the local stack. It skips (rather than fails) when the local database
 * is unreachable, so a developer without Docker running is not blocked; CI runs
 * it in the job that already boots Supabase for the migration replay.
 */

const CONNECTION_STRING = process.env.SUPABASE_TEST_DB_URL
  ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

/** Concurrent callers. More than two, so the loser path is exercised repeatedly. */
const CONCURRENCY = 6;

const BUYER = 'c1000000-0000-4000-8000-000000000001';
const AUTHOR = 'c2000000-0000-4000-8000-000000000002';
const POST = 'c3000000-0000-4000-8000-000000000003';
const STARTING_CREDITS = 1000;
const BUNDLE_PRICE_CENTS = 200;

let available = false;
let admin: Client;

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: CONNECTION_STRING });
  await client.connect();
  return client;
}

beforeAll(async () => {
  try {
    admin = await connect();
    available = true;
  } catch {
    available = false;
    return;
  }

  // Fixture ids are prefix-distinct because `handle_new_user` derives usernames
  // from the first eight hex characters of the user id, so ids sharing a prefix
  // collide on the username unique index.
  await admin.query('delete from auth.users where id = any($1::uuid[])', [[BUYER, AUTHOR]]);
  await admin.query(
    `insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
     values ($1, 'concurrency-buyer@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
            ($2, 'concurrency-author@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb)`,
    [BUYER, AUTHOR],
  );
  await admin.query(
    'update public.profiles set credits = $2, promotional_credits = 0 where id = $1',
    [BUYER, STARTING_CREDITS],
  );
  await admin.query(
    'update public.profiles set credits = 0, promotional_credits = 0 where id = $1',
    [AUTHOR],
  );
  await admin.query(
    `insert into public.posts (id, user_id, visibility, category, source_kind, post_format, body)
     values ($1, $2, 'public', 'text', 'external', 'text', 'concurrency bundle post')`,
    [POST, AUTHOR],
  );
  await admin.query(
    `insert into public.post_resource_bundles
       (post_id, owner_user_id, access_mode, status, title, price_usd_cents, prompt_text)
     values ($1, $2, 'paid', 'published', 'Concurrency bundle', $3, 'the unlockable prompt')`,
    [POST, AUTHOR, BUNDLE_PRICE_CENTS],
  );
});

afterAll(async () => {
  if (!available) return;
  await admin.query('delete from auth.users where id = any($1::uuid[])', [[BUYER, AUTHOR]]);
  await admin.end();
});

describe.runIf(process.env.VITEST_SKIP_DB !== '1')('credit unlock concurrency', () => {
  it('charges once when N callers unlock the same bundle simultaneously', async () => {
    if (!available) {
      console.warn('[concurrency] local database unreachable — skipping');
      return;
    }

    const clients = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => connect()),
    );

    try {
      // Barrier: admin holds the advisory lock EXCLUSIVELY while every caller
      // queues for it in SHARED mode. Shared requests are mutually compatible,
      // so releasing the exclusive hold admits all six at the same instant.
      //
      // This must be shared, not exclusive. An exclusive lock would admit the
      // callers one at a time, quietly turning this into a sequential replay
      // test — which pgTAP already covers — while still passing and looking
      // like concurrency coverage.
      await admin.query('select pg_advisory_lock(918273645)');

      const gates = clients.map((client) => ({
        client,
        gate: client.query('select pg_advisory_lock_shared(918273645)'),
      }));

      // Give every caller time to actually reach the lock and block on it,
      // otherwise a slow connection could arrive after the barrier lifts.
      await new Promise((resolve) => { setTimeout(resolve, 250); });

      const { rows: waiting } = await admin.query(
        "select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted",
      );
      expect(waiting[0].n).toBe(CONCURRENCY);

      // Release; all six now contend for the same bundle row simultaneously.
      await admin.query('select pg_advisory_unlock(918273645)');

      const results = await Promise.all(gates.map(async ({ client, gate }) => {
        await gate;
        const { rows } = await client.query(
          'select public.unlock_post_resource_bundle_with_credits($1::uuid, $2::uuid) as result',
          [BUYER, POST],
        );
        return rows[0].result as { status: string };
      }));

      const statuses = results.map((result) => result.status);
      const completed = statuses.filter((status) => status === 'completed');
      const alreadyOwned = statuses.filter((status) => status === 'already_owned');

      // The load-bearing assertion: exactly one caller may win.
      expect(completed).toHaveLength(1);
      expect(completed.length + alreadyOwned.length).toBe(CONCURRENCY);

      const { rows: balanceRows } = await admin.query(
        'select credits from public.profiles where id = $1',
        [BUYER],
      );
      const charged = STARTING_CREDITS - Number(balanceRows[0].credits);
      expect(charged).toBeGreaterThan(0);

      // Charged exactly once, not once per concurrent caller.
      // Entitlement is keyed by bundle, not post, so join through the bundle.
      const { rows: purchaseRows } = await admin.query(
        `select count(*)::int as n
         from public.post_resource_bundle_purchases p
         join public.post_resource_bundles b on b.id = p.bundle_id
         where p.buyer_user_id = $1 and b.post_id = $2`,
        [BUYER, POST],
      );
      expect(purchaseRows[0].n).toBe(1);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  }, 60_000);

  it('charges exactly one bundle price, not one per concurrent caller', async () => {
    if (!available) return;

    const { rows } = await admin.query(
      'select credits from public.profiles where id = $1',
      [BUYER],
    );
    const charged = STARTING_CREDITS - Number(rows[0].credits);

    // The RPC debits price_usd_cents. This is the assertion that would fail on
    // a lost update: a race charging twice lands on exactly 2x, six times on
    // 6x. Pinning the exact figure is what makes the failure legible.
    expect(charged).toBe(BUNDLE_PRICE_CENTS);
    expect(charged).not.toBe(BUNDLE_PRICE_CENTS * CONCURRENCY);
  });
});
