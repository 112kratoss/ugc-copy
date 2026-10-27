-- Recipes keep what they sell (20261027172920_sold_recipes_can_be_corrected.sql).
--
-- * A sold recipe can be corrected through the guarded mutation: content and
--   price change, each change is a new revision, and the buyer keeps the
--   revision they bought (owner decision D1, 2026-10-27).
-- * Removing a recipe that anyone has (a paid sale or a free unlock) retires
--   it -- draft, retired_at set -- and the buyer keeps it; one nobody has is
--   deleted. A retired recipe stays retired when its post is public again,
--   until a recipe is saved on the post again.
-- * A sold draft is listed again only if it passes the quality gate.
-- * A credits unlock spends nothing when the price the buyer confirmed is not
--   the live one (recipe audit H4); without a confirmed price it charges the
--   live price as every earlier client expects.
-- * A sold recipe still cannot move to another post.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(39);

-- ─── Fixtures ───────────────────────────────────────────────────────────────

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values
  ('a7c00001-0000-4000-8000-000000000001'::uuid, 'correct-seller@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now())),
  ('a7c00002-0000-4000-8000-000000000002'::uuid, 'correct-buyer@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now())),
  ('a7c00003-0000-4000-8000-000000000003'::uuid, 'correct-opener@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now()));

update public.profiles
set username = 'correctauthor', display_name = 'Correct Author'
where id = 'a7c00001-0000-4000-8000-000000000001'::uuid;

update public.profiles
set credits = 5000, promotional_credits = 0
where id in (
  'a7c00002-0000-4000-8000-000000000002'::uuid,
  'a7c00003-0000-4000-8000-000000000003'::uuid
);

insert into public.posts (id, user_id, visibility, category, source_kind, post_format, title, body)
values
  ('b7c00001-0000-4000-8000-000000000001'::uuid, 'a7c00001-0000-4000-8000-000000000001'::uuid,
   'public', 'text', 'external', 'text', 'Sold recipe fixture post', 'A body long enough to read as real public content.'),
  ('b7c00002-0000-4000-8000-000000000002'::uuid, 'a7c00001-0000-4000-8000-000000000001'::uuid,
   'public', 'text', 'external', 'text', 'Free recipe fixture post', 'A body long enough to read as real public content.'),
  ('b7c00003-0000-4000-8000-000000000003'::uuid, 'a7c00001-0000-4000-8000-000000000001'::uuid,
   'private', 'text', 'external', 'text', 'Unsold recipe fixture post', 'A body long enough to read as real public content.'),
  ('b7c00004-0000-4000-8000-000000000004'::uuid, 'a7c00001-0000-4000-8000-000000000001'::uuid,
   'public', 'text', 'external', 'text', 'Repriced recipe fixture post', 'A body long enough to read as real public content.'),
  ('b7c00005-0000-4000-8000-000000000005'::uuid, 'a7c00001-0000-4000-8000-000000000001'::uuid,
   'public', 'text', 'external', 'text', 'A post with no recipe', 'A body long enough to read as real public content.');

insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  prompt_text, price_usd_cents
)
values
  ('c7c00001-0000-4000-8000-000000000001'::uuid, 'b7c00001-0000-4000-8000-000000000001'::uuid,
   'a7c00001-0000-4000-8000-000000000001'::uuid, 'paid', 'published', 'Sold recipe fixture post',
   'Someone bought this one already.', 'A preview long enough to satisfy the marketplace quality gate.',
   'THE ORIGINAL PROMPT, long enough to count as a real resource.', 500),
  ('c7c00002-0000-4000-8000-000000000002'::uuid, 'b7c00002-0000-4000-8000-000000000002'::uuid,
   'a7c00001-0000-4000-8000-000000000001'::uuid, 'free', 'published', 'Free recipe fixture post',
   'Anyone can take this recipe.', 'A preview long enough to satisfy the marketplace quality gate.',
   'A free prompt that is long enough to count as a real resource.', 0),
  ('c7c00003-0000-4000-8000-000000000003'::uuid, 'b7c00003-0000-4000-8000-000000000003'::uuid,
   'a7c00001-0000-4000-8000-000000000001'::uuid, 'paid', 'draft', 'Unsold recipe fixture post',
   'Nobody has this one.', 'A preview long enough to satisfy the marketplace quality gate.',
   'An unsold prompt that is long enough to count as a real resource.', 500),
  ('c7c00004-0000-4000-8000-000000000004'::uuid, 'b7c00004-0000-4000-8000-000000000004'::uuid,
   'a7c00001-0000-4000-8000-000000000001'::uuid, 'paid', 'published', 'Repriced recipe fixture post',
   'Its price moves while a buyer looks.', 'A preview long enough to satisfy the marketplace quality gate.',
   'A repriced prompt that is long enough to count as a real resource.', 300);

-- A paid sale of the first recipe, through the call every earlier client makes.
select is(
  public.unlock_post_resource_bundle_with_credits(
    'a7c00002-0000-4000-8000-000000000002'::uuid,
    'b7c00001-0000-4000-8000-000000000001'::uuid
  )->>'status',
  'completed',
  'the two-argument credits unlock still settles at the live price'
);

-- ─── A sold recipe can be corrected ─────────────────────────────────────────

select lives_ok(
  $$ select * from public.apply_post_resource_bundle_mutation(
       'b7c00001-0000-4000-8000-000000000001'::uuid,
       'a7c00001-0000-4000-8000-000000000001'::uuid,
       'Sold recipe fixture post',
       'private',
       '{"accessMode": "paid", "priceUsdCents": 700,
         "summary": "Someone bought this one already.",
         "previewText": "A preview long enough to satisfy the marketplace quality gate.",
         "resources": {"promptText": "THE CORRECTED PROMPT, long enough to count as a real resource."}}'::jsonb
     ) $$,
  'saving a correction and a new price on a sold recipe is not refused'
);
select is(
  (select array[prompt_text, price_usd_cents::text]
   from public.post_resource_bundles where id = 'c7c00001-0000-4000-8000-000000000001'::uuid),
  array['THE CORRECTED PROMPT, long enough to count as a real resource.', '700'],
  'the sold recipe holds the correction and the new price'
);
select is(
  (select count(*)::int from public.post_resource_bundle_revisions
   where bundle_id = 'c7c00001-0000-4000-8000-000000000001'::uuid),
  2,
  'the correction is a new revision'
);
select is(
  (select revisions.prompt_text
   from public.post_resource_bundle_purchases as purchases
   join public.post_resource_bundle_revisions as revisions on revisions.id = purchases.revision_id
   where purchases.bundle_id = 'c7c00001-0000-4000-8000-000000000001'::uuid),
  'THE ORIGINAL PROMPT, long enough to count as a real resource.',
  'the buyer keeps the revision they bought'
);
select ok(
  not (select is_latest from public.get_purchased_post_resource_bundle_revision(
    'c7c00001-0000-4000-8000-000000000001'::uuid,
    'a7c00002-0000-4000-8000-000000000002'::uuid
  )),
  'the buyer is told a newer version exists'
);

-- ─── Removing a sold recipe retires it ──────────────────────────────────────

select lives_ok(
  $$ select * from public.apply_post_resource_bundle_mutation(
       'b7c00001-0000-4000-8000-000000000001'::uuid,
       'a7c00001-0000-4000-8000-000000000001'::uuid,
       'Sold recipe fixture post',
       'public',
       '{"accessMode": "none"}'::jsonb
     ) $$,
  'removing a sold recipe is not refused'
);
select is(
  (select status from public.post_resource_bundles where id = 'c7c00001-0000-4000-8000-000000000001'::uuid),
  'draft',
  'the removed sold recipe is kept, off sale'
);
select ok(
  (select retired_at is not null from public.post_resource_bundles
   where id = 'c7c00001-0000-4000-8000-000000000001'::uuid),
  'the removed sold recipe is marked retired'
);
select is(
  (select bundle_id from public.post_resource_bundle_purchases
   where buyer_user_id = 'a7c00002-0000-4000-8000-000000000002'::uuid
     and bundle_id = 'c7c00001-0000-4000-8000-000000000001'::uuid),
  'c7c00001-0000-4000-8000-000000000001'::uuid,
  'the buyer still has the retired recipe'
);
select is(
  (select count(*)::int from public.post_resource_bundle_revisions
   where bundle_id = 'c7c00001-0000-4000-8000-000000000001'::uuid),
  2,
  'retiring changes no content, so it mints no revision'
);

-- A retired recipe stays retired through its post's visibility.
update public.posts set visibility = 'private'
where id = 'b7c00001-0000-4000-8000-000000000001'::uuid;
update public.posts set visibility = 'public'
where id = 'b7c00001-0000-4000-8000-000000000001'::uuid;

select is(
  (select status from public.post_resource_bundles where id = 'c7c00001-0000-4000-8000-000000000001'::uuid),
  'draft',
  'a retired recipe is not listed again when its post is public again'
);
select ok(
  (select retired_at is not null from public.post_resource_bundles
   where id = 'c7c00001-0000-4000-8000-000000000001'::uuid),
  'and it stays retired'
);

-- Saving a recipe on the post again brings the row back, even as a draft.
select lives_ok(
  $$ select * from public.apply_post_resource_bundle_mutation(
       'b7c00001-0000-4000-8000-000000000001'::uuid,
       'a7c00001-0000-4000-8000-000000000001'::uuid,
       'Sold recipe fixture post',
       'private',
       '{"accessMode": "paid", "priceUsdCents": 700,
         "summary": "Someone bought this one already.",
         "previewText": "A preview long enough to satisfy the marketplace quality gate.",
         "resources": {"promptText": "THE RETURNING PROMPT, long enough to count as a real resource."}}'::jsonb
     ) $$,
  'a recipe can be saved again on the post of a retired one'
);
select ok(
  (select retired_at is null from public.post_resource_bundles
   where id = 'c7c00001-0000-4000-8000-000000000001'::uuid),
  'saving it again clears the retirement, though the save keeps it a draft'
);
select is(
  public.post_resource_bundle_quality_issue_for('c7c00001-0000-4000-8000-000000000001'::uuid),
  null,
  'the recipe saved again passes the quality gate'
);

update public.posts set visibility = 'public'
where id = 'b7c00001-0000-4000-8000-000000000001'::uuid;

select is(
  (select status from public.post_resource_bundles where id = 'c7c00001-0000-4000-8000-000000000001'::uuid),
  'published',
  'the recipe saved again is listed once its post is public'
);

-- ─── Removing a recipe someone opened for free retires it too ───────────────

select is(
  public.unlock_free_post_resource_bundle(
    'a7c00003-0000-4000-8000-000000000003'::uuid,
    'b7c00002-0000-4000-8000-000000000002'::uuid,
    'free_bundle_correct_1',
    'free_unlock_correct_1'
  )->>'status',
  'completed',
  'fixture: someone opens the free recipe'
);
select lives_ok(
  $$ select * from public.apply_post_resource_bundle_mutation(
       'b7c00002-0000-4000-8000-000000000002'::uuid,
       'a7c00001-0000-4000-8000-000000000001'::uuid,
       'Free recipe fixture post',
       'public',
       '{"accessMode": "none"}'::jsonb
     ) $$,
  'removing a free recipe someone opened is not refused'
);
select is(
  (select array[status, (retired_at is not null)::text]
   from public.post_resource_bundles where id = 'c7c00002-0000-4000-8000-000000000002'::uuid),
  array['draft', 'true'],
  'the opened free recipe is retired, not deleted'
);
select is(
  (select count(*)::int from public.post_resource_bundle_purchases
   where bundle_id = 'c7c00002-0000-4000-8000-000000000002'::uuid
     and buyer_user_id = 'a7c00003-0000-4000-8000-000000000003'::uuid),
  1,
  'the person who opened it keeps it'
);

-- ─── A recipe nobody has is deleted as before ───────────────────────────────

select lives_ok(
  $$ select * from public.apply_post_resource_bundle_mutation(
       'b7c00003-0000-4000-8000-000000000003'::uuid,
       'a7c00001-0000-4000-8000-000000000001'::uuid,
       'Unsold recipe fixture post',
       'private',
       '{"accessMode": "none"}'::jsonb
     ) $$,
  'removing a recipe nobody has saves'
);
select is(
  (select count(*)::int from public.post_resource_bundles
   where id = 'c7c00003-0000-4000-8000-000000000003'::uuid),
  0,
  'a recipe nobody has is deleted'
);

-- ─── A credits unlock charges the confirmed price ───────────────────────────

select is(
  (select array[result->>'status', result->>'credit_cost']
   from (select public.unlock_post_resource_bundle_with_credits(
     'a7c00002-0000-4000-8000-000000000002'::uuid,
     'b7c00004-0000-4000-8000-000000000004'::uuid,
     200
   ) as result) as unlock),
  array['price_changed', '300'],
  'a confirmed price that is not the live one is refused with the live price'
);
select is(
  (select credits from public.profiles where id = 'a7c00002-0000-4000-8000-000000000002'::uuid),
  4500,
  'the refused unlock spends nothing'
);
select is(
  (select count(*)::int from public.post_resource_bundle_purchases
   where bundle_id = 'c7c00004-0000-4000-8000-000000000004'::uuid),
  0,
  'the refused unlock records no purchase'
);

-- A recipe made free after the buyer saw its price: a price change to 0, not
-- "not paid", so the client can take the free path.
update public.post_resource_bundles set access_mode = 'free', price_usd_cents = 0
where id = 'c7c00004-0000-4000-8000-000000000004'::uuid;
select is(
  (select array[result->>'status', result->>'credit_cost']
   from (select public.unlock_post_resource_bundle_with_credits(
     'a7c00002-0000-4000-8000-000000000002'::uuid,
     'b7c00004-0000-4000-8000-000000000004'::uuid,
     300
   ) as result) as unlock),
  array['price_changed', '0'],
  'a confirmed price on a recipe made free meanwhile is refused with 0'
);
select is(
  (select credits from public.profiles where id = 'a7c00002-0000-4000-8000-000000000002'::uuid),
  4500,
  'and that spends nothing either'
);
update public.post_resource_bundles set access_mode = 'paid', price_usd_cents = 300
where id = 'c7c00004-0000-4000-8000-000000000004'::uuid;
select is(
  public.unlock_post_resource_bundle_with_credits(
    'a7c00002-0000-4000-8000-000000000002'::uuid,
    'b7c00004-0000-4000-8000-000000000004'::uuid,
    300
  )->>'status',
  'completed',
  'the live price, confirmed, settles'
);
select is(
  (select credits from public.profiles where id = 'a7c00002-0000-4000-8000-000000000002'::uuid),
  4200,
  'and spends exactly that price'
);
select is(
  public.unlock_post_resource_bundle_with_credits(
    'a7c00003-0000-4000-8000-000000000003'::uuid,
    'b7c00004-0000-4000-8000-000000000004'::uuid,
    null
  )->>'status',
  'completed',
  'no confirmed price charges the live one'
);
select is(
  public.unlock_post_resource_bundle_with_credits(
    'a7c00002-0000-4000-8000-000000000002'::uuid,
    'b7c00004-0000-4000-8000-000000000004'::uuid,
    100
  )->>'status',
  'already_owned',
  'a buyer who already has it is told so, whatever price they send'
);

-- ─── A sold draft is listed again only if it passes the quality gate ────────

update public.posts set visibility = 'private'
where id = 'b7c00004-0000-4000-8000-000000000004'::uuid;
update public.post_resource_bundles
set prompt_text = 'too short', resource_items = '[]'::jsonb
where id = 'c7c00004-0000-4000-8000-000000000004'::uuid;

select isnt(
  public.post_resource_bundle_quality_issue_for('c7c00004-0000-4000-8000-000000000004'::uuid),
  null,
  'fixture: the sold recipe, edited while its post was private, fails the gate'
);

update public.posts set visibility = 'public'
where id = 'b7c00004-0000-4000-8000-000000000004'::uuid;

select is(
  (select status from public.post_resource_bundles where id = 'c7c00004-0000-4000-8000-000000000004'::uuid),
  'draft',
  'a sold recipe that fails the gate stays a draft when its post is public again'
);

-- ─── A sold recipe stays with its post ──────────────────────────────────────

select throws_ok(
  $$ update public.post_resource_bundles
     set post_id = 'b7c00005-0000-4000-8000-000000000005'::uuid
     where id = 'c7c00004-0000-4000-8000-000000000004'::uuid $$,
  'P0001',
  'RESOURCE_BUNDLE_LOCKED: a purchased recipe stays with its post and creator',
  'a sold recipe cannot move to another post'
);

-- ─── Surface ────────────────────────────────────────────────────────────────

select ok(
  to_regprocedure('public.unlock_post_resource_bundle_with_credits(uuid, uuid)') is null,
  'the two-argument credits unlock is replaced, not overloaded'
);
select ok(
  has_function_privilege('service_role', 'public.unlock_post_resource_bundle_with_credits(uuid, uuid, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.unlock_post_resource_bundle_with_credits(uuid, uuid, integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.unlock_post_resource_bundle_with_credits(uuid, uuid, integer)', 'EXECUTE'),
  'the credits unlock stays callable by the service role only'
);
select ok(
  (select procedures.prosecdef
     and pg_catalog.pg_get_userbyid(procedures.proowner) = 'postgres'
     and procedures.proconfig @> array['search_path=""']
     and not has_function_privilege('service_role', procedures.oid, 'EXECUTE')
     and not has_function_privilege('authenticated', procedures.oid, 'EXECUTE')
     and not has_function_privilege('anon', procedures.oid, 'EXECUTE')
   from pg_catalog.pg_proc as procedures
   where procedures.oid = 'public.retire_sold_post_resource_bundle_instead_of_delete()'::regprocedure),
  'the retire trigger runs as its owner with an empty search path and no caller grants'
);
select has_trigger(
  'public', 'post_resource_bundles', 'post_resource_bundles_retire_instead_of_delete',
  'bundles carry the retire-instead-of-delete trigger again'
);

select finish();

rollback;
