-- Pin the anonymous Data API boundary independently of RLS. Internal tables
-- must have no anonymous ACL path; the four deliberately public read surfaces
-- must remain readable without inheriting table-maintenance authority.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(16);

select is(
  (
    select count(*)
    from unnest(array[
      'ai_usage_events',
      'generation_input_media',
      'marketplace_asset_content',
      'mobile_notification_preferences',
      'mobile_notifications',
      'mobile_push_tokens',
      'post_deletion_audits',
      'post_save_events',
      'post_saves',
      'profiles',
      'workflow_canvas_assistant_messages',
      'workflow_canvas_assistant_proposals',
      'workflow_canvas_history',
      'workflow_canvases'
    ]::text[]) as targets(table_name)
  ),
  14::bigint,
  'the internal anonymous-grant contract covers all fourteen confirmed tables'
);

select ok(
  not exists (
    select 1
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    cross join lateral aclexplode(relation.relacl) as acl
    join pg_roles as grantee on grantee.oid = acl.grantee
    where namespace.nspname = 'public'
      and relation.relname = any(array[
        'ai_usage_events',
        'generation_input_media',
        'marketplace_asset_content',
        'mobile_notification_preferences',
        'mobile_notifications',
        'mobile_push_tokens',
        'post_deletion_audits',
        'post_save_events',
        'post_saves',
        'profiles',
        'workflow_canvas_assistant_messages',
        'workflow_canvas_assistant_proposals',
        'workflow_canvas_history',
        'workflow_canvases'
      ]::name[])
      and grantee.rolname = 'anon'
  ),
  'internal tables expose no relation-level privilege to anon, including MAINTAIN'
);

select ok(
  not exists (
    select 1
    from pg_attribute as attribute
    join pg_class as relation on relation.oid = attribute.attrelid
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    cross join lateral aclexplode(attribute.attacl) as acl
    join pg_roles as grantee on grantee.oid = acl.grantee
    where namespace.nspname = 'public'
      and relation.relname = any(array[
        'ai_usage_events',
        'generation_input_media',
        'marketplace_asset_content',
        'mobile_notification_preferences',
        'mobile_notifications',
        'mobile_push_tokens',
        'post_deletion_audits',
        'post_save_events',
        'post_saves',
        'profiles',
        'workflow_canvas_assistant_messages',
        'workflow_canvas_assistant_proposals',
        'workflow_canvas_history',
        'workflow_canvases'
      ]::name[])
      and grantee.rolname = 'anon'
  ),
  'internal tables expose no column-level privilege to anon'
);

select ok(
  not exists (
    select 1
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    cross join lateral aclexplode(relation.relacl) as acl
    join pg_roles as grantee on grantee.oid = acl.grantee
    where namespace.nspname = 'public'
      and relation.relname = any(array[
        'follows', 'source_tool_models', 'source_tools', 'templates'
      ]::name[])
      and grantee.rolname = 'anon'
      and acl.privilege_type = 'MAINTAIN'
  ),
  'public read surfaces grant no table-maintenance authority to anon'
);

select ok(
  has_table_privilege('anon', 'public.follows', 'SELECT')
    and has_table_privilege('anon', 'public.source_tool_models', 'SELECT')
    and has_table_privilege('anon', 'public.source_tools', 'SELECT'),
  'the three table-level public read grants remain intact'
);

select is(
  has_table_privilege('anon', 'public.templates', 'SELECT'),
  false,
  'templates does not widen its intentionally column-scoped read to table SELECT'
);

select ok(
  has_column_privilege('anon', 'public.templates', 'id', 'SELECT')
    and has_column_privilege('anon', 'public.templates', 'name', 'SELECT')
    and has_column_privilege('anon', 'public.templates', 'active_version_id', 'SELECT'),
  'the anonymous template catalog projection remains readable'
);

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

select lives_ok(
  $$ select follower_id, following_id from public.follows limit 1 $$,
  'anonymous callers can still read public follows'
);
select lives_ok(
  $$ select id, slug, label from public.source_tools where is_active limit 1 $$,
  'anonymous callers can still read the active source-tool catalog'
);
select lives_ok(
  $$ select id, slug, label from public.source_tool_models where is_active limit 1 $$,
  'anonymous callers can still read the active source-model catalog'
);
select lives_ok(
  $$ select id, name, active_version_id from public.templates where is_active limit 1 $$,
  'anonymous callers can still read the public template projection'
);

select throws_ok(
  $$ select id from public.ai_usage_events limit 1 $$,
  '42501', null,
  'anonymous callers cannot query AI usage and prompt history'
);
select throws_ok(
  $$ select asset_id from public.marketplace_asset_content limit 1 $$,
  '42501', null,
  'anonymous callers cannot query paid marketplace content'
);
select throws_ok(
  $$ select id from public.mobile_push_tokens limit 1 $$,
  '42501', null,
  'anonymous callers cannot query mobile push tokens'
);
select throws_ok(
  $$ select id from public.profiles limit 1 $$,
  '42501', null,
  'anonymous callers cannot query profile and credit rows directly'
);
select throws_ok(
  $$ select id from public.workflow_canvases limit 1 $$,
  '42501', null,
  'anonymous callers cannot query private workflow canvases'
);

reset role;
select set_config('request.jwt.claims', '{}', true);

select * from finish();
rollback;
