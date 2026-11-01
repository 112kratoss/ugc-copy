-- A media sweep uploads a derivative beside a creation's public copy before
-- its row update names it. When that update matches no row, the sweep hands
-- the paths to the revocation queue through a trusted function, since the
-- queue takes no INSERT from service_role. The showcase-media-revocations job
-- then keeps what something still names and removes the rest.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(17);

select has_function(
  'public', 'queue_unrecorded_showcase_media', array['text[]'],
  'the sweeps have an entry to the revocation queue'
);
select ok(
  (select prosecdef from pg_proc where oid = 'public.queue_unrecorded_showcase_media(text[])'::regprocedure),
  'it writes the queue as its owner'
);
select ok(
  (select proconfig @> array['search_path=""'] from pg_proc where oid = 'public.queue_unrecorded_showcase_media(text[])'::regprocedure),
  'with an empty search path'
);
select ok(
  (
    select proacl is not null and not exists (
      select 1 from aclexplode(proacl) as acl where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
    )
    from pg_proc where oid = 'public.queue_unrecorded_showcase_media(text[])'::regprocedure
  ),
  'PUBLIC cannot call it'
);
select ok(
  not has_function_privilege('anon', 'public.queue_unrecorded_showcase_media(text[])', 'EXECUTE'),
  'anon cannot call it'
);
select ok(
  not has_function_privilege('authenticated', 'public.queue_unrecorded_showcase_media(text[])', 'EXECUTE'),
  'authenticated cannot call it'
);
select ok(
  has_function_privilege('service_role', 'public.queue_unrecorded_showcase_media(text[])', 'EXECUTE'),
  'the service role, which runs the sweeps, can'
);
select ok(
  not has_table_privilege('service_role', 'public.showcase_media_revocations', 'INSERT'),
  'the queue itself still takes no INSERT from the service role'
);

set local role authenticated;
select throws_ok(
  $$select public.queue_unrecorded_showcase_media(array['showcase/ee200000-0000-4000-8000-000000000001/a.preview.x.webp'])$$,
  '42501', null,
  'a signed-in user cannot queue a creation''s media for removal'
);
reset role;

-- A path the posts trigger already queued keeps its row and reason.
insert into public.showcase_media_revocations (generation_id, post_id, showcase_asset_path, reason)
values (
  'ee200000-0000-4000-8000-000000000003'::uuid, 'ee300000-0000-4000-8000-000000000009'::uuid,
  'showcase/ee200000-0000-4000-8000-000000000003/c.teaser.z.mp4', 'post_deleted'
);

set local role service_role;
select is(
  public.queue_unrecorded_showcase_media(array[
    'showcase/ee200000-0000-4000-8000-000000000001/a.preview.x.webp',
    'showcase/ee200000-0000-4000-8000-000000000001/a.preview.x.webp',
    'showcase/ee200000-0000-4000-8000-000000000002/b.feed.y.mp4',
    'showcase/ee200000-0000-4000-8000-000000000003/c.teaser.z.mp4',
    'posts/ee300000-0000-4000-8000-000000000001/photo.preview.x.webp',
    'private-posts/ee300000-0000-4000-8000-000000000001/photo.preview.x.webp',
    'showcase/not-a-creation/a.preview.x.webp',
    null
  ]),
  2,
  'queues each new path in a creation''s public folder once, and nothing outside one'
);
select is(
  public.queue_unrecorded_showcase_media(array[
    'showcase/EE200000-0000-4000-8000-000000000001/a.preview.x.webp',
    'showcase/ee200000-0000-4000-8000-000000000001/',
    ''
  ]),
  0,
  'a folder name that is not a creation id, or no object in the folder, queues nothing'
);
select is(
  public.queue_unrecorded_showcase_media(array['showcase/ee200000-0000-4000-8000-000000000001/a.preview.x.webp']),
  0,
  'a path already queued is queued once'
);
select is(public.queue_unrecorded_showcase_media(null), 0, 'no paths queue nothing');
select throws_ok(
  $$select public.queue_unrecorded_showcase_media(array_fill('showcase/ee200000-0000-4000-8000-000000000001/a.webp'::text, array[9]))$$,
  '22023', null,
  'refuses more paths than one sweep run uploads'
);
reset role;

select results_eq(
  $$
    select generation_id, post_id, showcase_asset_path, reason, attempt_count, last_error
    from public.showcase_media_revocations
    where generation_id::text like 'ee2%'
    order by showcase_asset_path
  $$,
  $$
    values
      (
        'ee200000-0000-4000-8000-000000000001'::uuid, null::uuid,
        'showcase/ee200000-0000-4000-8000-000000000001/a.preview.x.webp', 'sweep_unrecorded', 0, null::text
      ),
      (
        'ee200000-0000-4000-8000-000000000002'::uuid, null::uuid,
        'showcase/ee200000-0000-4000-8000-000000000002/b.feed.y.mp4', 'sweep_unrecorded', 0, null::text
      ),
      (
        'ee200000-0000-4000-8000-000000000003'::uuid, 'ee300000-0000-4000-8000-000000000009'::uuid,
        'showcase/ee200000-0000-4000-8000-000000000003/c.teaser.z.mp4', 'post_deleted', 0, null::text
      )
  $$,
  'each queued under the creation its folder names, and the trigger''s row untouched'
);
select ok(
  (
    select bool_and(next_attempt_at <= now())
    from public.showcase_media_revocations
    where generation_id::text like 'ee2%'
  ),
  'the job may take them on its next run'
);

select throws_ok(
  $$insert into public.showcase_media_revocations (generation_id, showcase_asset_path, reason) values ('ee200000-0000-4000-8000-000000000004', 'showcase/ee200000-0000-4000-8000-000000000004/d.webp', 'anything_else')$$,
  '23514', null,
  'the queue still refuses a reason no writer gives'
);

select * from finish();
rollback;
