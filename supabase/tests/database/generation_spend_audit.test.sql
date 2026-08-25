-- Behavioural coverage for the generation spend audit.
--
-- Asserted against real rows rather than migration text, because the property
-- that matters most here is an interaction the SQL does not state on its face:
-- `generations.user_id` is `REFERENCES auth.users ON DELETE CASCADE`, so the
-- AFTER DELETE trigger also fires while an account is being erased. If the audit
-- insert ran then, it would fail its own foreign key against a user row that is
-- already gone and abort the account deletion.
--
-- The invariants below:
--   * deleting a creation preserves what it cost
--   * a refunded generation is recorded as refunded, so net spend survives
--   * deleting an account still works, and leaves no spend history behind
--   * free generations write nothing
--   * the audit can never abort the delete that triggers it

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(10);

-- ─── Privilege boundaries ────────────────────────────────────────────────────

select is(
  (select pg_catalog.has_table_privilege('authenticated', 'public.generation_spend_audits', 'SELECT')),
  false,
  'a signed-in client cannot read anyone''s spend history'
);

select is(
  (select pg_catalog.has_table_privilege('service_role', 'public.generation_spend_audits', 'UPDATE')),
  false,
  'the audit is append-only even for the service role'
);

select is(
  (select pg_catalog.has_table_privilege('service_role', 'public.generation_spend_audits', 'DELETE')),
  false,
  'audit rows cannot be deleted by the code that writes them'
);

-- ─── Fixtures ────────────────────────────────────────────────────────────────

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at, is_anonymous)
values
  ('c1c1c1c1-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'keeper@example.test', '', now(), now(), false),
  ('c2c2c2c2-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'leaver@example.test', '', now(), now(), false);

insert into public.generations (id, user_id, model, cost, category, status, promotional_credits_used, refunded)
values
  ('d1d1d1d1-0000-4000-8000-000000000001', 'c1c1c1c1-0000-4000-8000-000000000001', 'nano-banana-2', 18, 'image', 'succeeded', 5, false),
  ('d2d2d2d2-0000-4000-8000-000000000002', 'c1c1c1c1-0000-4000-8000-000000000001', 'kling-3.0-video', 90, 'video', 'failed', 0, true),
  ('d3d3d3d3-0000-4000-8000-000000000003', 'c1c1c1c1-0000-4000-8000-000000000001', 'nano-banana-2-lite', 0, 'image', 'succeeded', 0, false),
  ('d4d4d4d4-0000-4000-8000-000000000004', 'c2c2c2c2-0000-4000-8000-000000000002', 'gpt-image-2', 6, 'image', 'succeeded', 0, false);

-- ─── Deleting a creation preserves what it cost ──────────────────────────────

delete from public.generations where id = 'd1d1d1d1-0000-4000-8000-000000000001';

select is(
  (select cost from public.generation_spend_audits where generation_id = 'd1d1d1d1-0000-4000-8000-000000000001'),
  18,
  'deleting a creation preserves what it cost'
);

select is(
  (select promotional_credits_used from public.generation_spend_audits where generation_id = 'd1d1d1d1-0000-4000-8000-000000000001'),
  5,
  'the promotional portion of the spend is preserved too'
);

-- ─── A refunded generation is recorded as refunded ───────────────────────────

delete from public.generations where id = 'd2d2d2d2-0000-4000-8000-000000000002';

select is(
  (select refunded from public.generation_spend_audits where generation_id = 'd2d2d2d2-0000-4000-8000-000000000002'),
  true,
  'a refunded generation is recorded as refunded, so net spend stays reconstructable'
);

-- ─── Free generations write nothing ──────────────────────────────────────────

delete from public.generations where id = 'd3d3d3d3-0000-4000-8000-000000000003';

select is(
  (select count(*) from public.generation_spend_audits where generation_id = 'd3d3d3d3-0000-4000-8000-000000000003'),
  0::bigint,
  'a free generation leaves no audit row'
);

-- ─── Account deletion still works, and leaves nothing behind ─────────────────
--
-- This is the regression the trigger was nearly responsible for: the cascade
-- from auth.users fires it, and an unguarded insert would abort the deletion.

select lives_ok(
  $$delete from auth.users where id = 'c2c2c2c2-0000-4000-8000-000000000002'$$,
  'deleting an account is not blocked by the spend audit trigger'
);

select is(
  (select count(*) from public.generation_spend_audits where user_id = 'c2c2c2c2-0000-4000-8000-000000000002'),
  0::bigint,
  'an erased account leaves no spend history behind'
);

-- ─── The audit never blocks a delete ─────────────────────────────────────────

select lives_ok(
  $$delete from public.generations where user_id = 'c1c1c1c1-0000-4000-8000-000000000001'$$,
  'deleting the remaining creations succeeds'
);

select * from finish();
rollback;
