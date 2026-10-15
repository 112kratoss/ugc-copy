-- Template reports: the widened target, one open report per reporter per
-- template, and the subject resolver's template take-down
-- (20261015122821_moderation_reports_template_target.sql), which holds the
-- template so its creator cannot publish it again
-- (20261015143633_template_moderation_hold.sql).

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(32);

-- Ids must differ in their FIRST 8 hex characters: handle_new_user() derives a
-- username as `creator-<left(uuid without dashes, 8)>`.
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values
  ('f7a00001-1000-4000-8000-000000000001'::uuid, 'template-report-creator@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now())),
  ('f7a00002-1000-4000-8000-000000000002'::uuid, 'template-report-reporter@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now())),
  ('f7a00003-1000-4000-8000-000000000003'::uuid, 'template-report-second@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now())),
  ('f7a00004-1000-4000-8000-000000000004'::uuid, 'template-report-reviewer@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now()));

insert into public.templates (id, name, slug, creator_user_id, status, is_active)
values
  ('f7b00001-1000-4000-8000-000000000001'::uuid, 'Reported template', 'template-report-taken-down',
   'f7a00001-1000-4000-8000-000000000001'::uuid, 'active', true),
  ('f7b00002-1000-4000-8000-000000000002'::uuid, 'Dismissed template', 'template-report-dismissed',
   'f7a00001-1000-4000-8000-000000000001'::uuid, 'active', true),
  ('f7b00003-1000-4000-8000-000000000003'::uuid, 'Removed template', 'template-report-removed',
   'f7a00001-1000-4000-8000-000000000001'::uuid, 'active', true);

-- The widened target and its guards ---------------------------------------

select lives_ok(
  $$insert into public.moderation_reports (id, reporter_user_id, target_type, template_id, reason, source_surface)
    values ('f7c00001-1000-4000-8000-000000000001'::uuid, 'f7a00002-1000-4000-8000-000000000002'::uuid,
            'template', 'f7b00001-1000-4000-8000-000000000001'::uuid, 'stolen_content', 'template-detail')$$,
  'a template is reported with a post-content reason from its page'
);

select throws_ok(
  $$insert into public.moderation_reports (id, reporter_user_id, target_type, template_id, reason, source_surface)
    values ('f7c00002-1000-4000-8000-000000000002'::uuid, 'f7a00002-1000-4000-8000-000000000002'::uuid,
            'template', 'f7b00001-1000-4000-8000-000000000001'::uuid, 'spam', 'template-detail')$$,
  '23505',
  null,
  'one reporter holds one open report per template'
);

select lives_ok(
  $$insert into public.moderation_reports (id, reporter_user_id, target_type, template_id, reason, source_surface)
    values ('f7c00003-1000-4000-8000-000000000003'::uuid, 'f7a00003-1000-4000-8000-000000000003'::uuid,
            'template', 'f7b00001-1000-4000-8000-000000000001'::uuid, 'spam', 'template-detail')$$,
  'another reporter can report the same template'
);

select lives_ok(
  $$insert into public.moderation_reports (id, reporter_user_id, target_type, template_id, reason, source_surface)
    values ('f7c00004-1000-4000-8000-000000000004'::uuid, 'f7a00002-1000-4000-8000-000000000002'::uuid,
            'template', 'f7b00002-1000-4000-8000-000000000002'::uuid, 'unsafe_content', 'template-detail')$$,
  'the same reporter can report a different template'
);

select throws_ok(
  $$insert into public.moderation_reports (reporter_user_id, target_type, template_id, reported_user_id, reason, source_surface)
    values ('f7a00003-1000-4000-8000-000000000003'::uuid, 'template', 'f7b00002-1000-4000-8000-000000000002'::uuid,
            'f7a00001-1000-4000-8000-000000000001'::uuid, 'spam', 'template-detail')$$,
  '23514',
  null,
  'a template report cannot also name a user'
);

select throws_ok(
  $$insert into public.moderation_reports (reporter_user_id, target_type, reported_user_id, template_id, reason, source_surface)
    values ('f7a00003-1000-4000-8000-000000000003'::uuid, 'user', 'f7a00001-1000-4000-8000-000000000001'::uuid,
            'f7b00002-1000-4000-8000-000000000002'::uuid, 'harassment', 'creator-profile')$$,
  '23514',
  null,
  'a user report cannot carry a template'
);

select throws_ok(
  $$insert into public.moderation_reports (reporter_user_id, target_type, template_id, reason, source_surface)
    values ('f7a00003-1000-4000-8000-000000000003'::uuid, 'template', 'f7b00002-1000-4000-8000-000000000002'::uuid,
            'spam', 'templates')$$,
  '23514',
  null,
  'a surface outside the list is refused'
);

-- A confirmed report takes the template down ------------------------------

create temporary table template_takedown_result as
select public.resolve_subject_report_for_ops(
  'f7c00001-1000-4000-8000-000000000001'::uuid,
  'f7a00004-1000-4000-8000-000000000004'::uuid,
  'resolve',
  'Demo media copied from another creator; policy 3.1.'
) as result;

select is(
  (select result ->> 'status' from template_takedown_result),
  'resolved',
  'a confirmed template report resolves'
);

select is(
  (select (result ->> 'template_disabled')::boolean from template_takedown_result),
  true,
  'the decision reports that it disabled the template'
);

select is(
  (select (result ->> 'resolved_report_count')::integer from template_takedown_result),
  2,
  'one take-down resolves every open report of the template'
);

select is(
  (select status from public.templates where id = 'f7b00001-1000-4000-8000-000000000001'::uuid),
  'disabled',
  'the taken-down template is disabled'
);

select is(
  (select is_active from public.templates where id = 'f7b00001-1000-4000-8000-000000000001'::uuid),
  false,
  'the taken-down template leaves the catalog'
);

select is(
  (select count(*) from public.moderation_reports
   where template_id = 'f7b00001-1000-4000-8000-000000000001'::uuid
     and status = 'resolved'
     and reviewed_by = 'f7a00004-1000-4000-8000-000000000004'::uuid
     and resolution_note = 'Demo media copied from another creator; policy 3.1.'),
  2::bigint,
  'the report and its duplicate carry the reviewer and the note that closed them'
);

select is(
  public.resolve_subject_report_for_ops(
    'f7c00003-1000-4000-8000-000000000003'::uuid,
    'f7a00004-1000-4000-8000-000000000004'::uuid,
    'dismiss',
    'Second look, different call.'
  ) ->> 'status',
  'already_resolved',
  'a report the take-down closed is not re-decided'
);

select lives_ok(
  $$insert into public.moderation_reports (id, reporter_user_id, target_type, template_id, reason, source_surface)
    values ('f7c00005-1000-4000-8000-000000000005'::uuid, 'f7a00002-1000-4000-8000-000000000002'::uuid,
            'template', 'f7b00001-1000-4000-8000-000000000001'::uuid, 'other', 'template-detail')$$,
  'a decided report frees its reporter to report the template again'
);

-- A dismissal leaves the template alone -----------------------------------

select is(
  public.resolve_subject_report_for_ops(
    'f7c00004-1000-4000-8000-000000000004'::uuid,
    'f7a00004-1000-4000-8000-000000000004'::uuid,
    'dismiss',
    'The demo matches what the template makes.'
  ) ->> 'status',
  'dismissed',
  'a non-violating template report is dismissed'
);

select is(
  (select status || '/' || is_active::text from public.templates
   where id = 'f7b00002-1000-4000-8000-000000000002'::uuid),
  'active/true',
  'a dismissal leaves the template live'
);

-- The take-down holds the template ---------------------------------------

select isnt(
  (select moderation_disabled_at from public.templates
   where id = 'f7b00001-1000-4000-8000-000000000001'::uuid),
  null,
  'the take-down holds the template'
);

select isnt(
  (select result ->> 'template_moderation_disabled_at' from template_takedown_result),
  null,
  'the decision names the hold'
);

select isnt(
  public.resolve_subject_report_for_ops(
    'f7c00003-1000-4000-8000-000000000003'::uuid,
    'f7a00004-1000-4000-8000-000000000004'::uuid,
    'dismiss',
    'Asked again after the take-down.'
  ) ->> 'template_moderation_disabled_at',
  null,
  'an answer about a closed report names the hold too'
);

select throws_ok(
  $$select public.activate_template_version(
      'f7d00001-1000-4000-8000-000000000001'::uuid,
      'f7b00001-1000-4000-8000-000000000001'::uuid,
      'f7a00001-1000-4000-8000-000000000001'::uuid,
      null, 1, '{}'::jsonb, 'template-hold-graph', 'template-hold-snapshot',
      'output', 'image', '[]'::jsonb, 0, null,
      'template_assets/f7b00001-1000-4000-8000-000000000001/f7d00001-1000-4000-8000-000000000001/demo/demo.png',
      timezone('utc'::text, now()))$$,
  'P0001',
  'This template was taken down by moderation and cannot be republished.',
  'its creator cannot publish the taken-down template again'
);

select is(
  (select count(*) from public.template_versions
   where template_id = 'f7b00001-1000-4000-8000-000000000001'::uuid),
  0::bigint,
  'the refused publish recorded no version'
);

select is(
  (select status || '/' || is_active::text from public.templates
   where id = 'f7b00001-1000-4000-8000-000000000001'::uuid),
  'disabled/false',
  'the taken-down template stays out of the catalog'
);

select throws_ok(
  $$update public.templates set status = 'active', is_active = true
    where id = 'f7b00001-1000-4000-8000-000000000001'::uuid$$,
  '23514',
  'new row for relation "templates" violates check constraint "templates_moderation_hold_check"',
  'no other writer can make a held template active'
);

select is(
  (select moderation_disabled_at from public.templates
   where id = 'f7b00002-1000-4000-8000-000000000002'::uuid),
  null,
  'a dismissal leaves no hold'
);

-- A template its creator had disabled before the decision is held too: the
-- creator's own Disable writes the same state, and their next publish used to
-- bring it back.
insert into public.templates (id, name, slug, creator_user_id, status, is_active)
values
  ('f7b00004-1000-4000-8000-000000000004'::uuid, 'Disabled before the decision', 'template-report-disabled-first',
   'f7a00001-1000-4000-8000-000000000001'::uuid, 'active', true),
  ('f7b00005-1000-4000-8000-000000000005'::uuid, 'Disabled by its creator', 'template-report-creator-disabled',
   'f7a00001-1000-4000-8000-000000000001'::uuid, 'disabled', false);

insert into public.moderation_reports (id, reporter_user_id, target_type, template_id, reason, source_surface)
values ('f7c00007-1000-4000-8000-000000000007'::uuid, 'f7a00002-1000-4000-8000-000000000002'::uuid,
        'template', 'f7b00004-1000-4000-8000-000000000004'::uuid, 'unsafe_content', 'template-detail');

update public.templates set status = 'disabled', is_active = false
where id = 'f7b00004-1000-4000-8000-000000000004'::uuid;

create temporary table disabled_first_takedown_result as
select public.resolve_subject_report_for_ops(
  'f7c00007-1000-4000-8000-000000000007'::uuid,
  'f7a00004-1000-4000-8000-000000000004'::uuid,
  'resolve',
  'Unsafe demo media; policy 2.4.'
) as result;

select is(
  (select (result ->> 'template_disabled')::boolean from disabled_first_takedown_result),
  false,
  'the decision says it found the template already disabled'
);

select isnt(
  (select moderation_disabled_at from public.templates
   where id = 'f7b00004-1000-4000-8000-000000000004'::uuid),
  null,
  'and holds it all the same'
);

select throws_ok(
  $$select public.activate_template_version(
      'f7d00004-1000-4000-8000-000000000004'::uuid,
      'f7b00004-1000-4000-8000-000000000004'::uuid,
      'f7a00001-1000-4000-8000-000000000001'::uuid,
      null, 1, '{}'::jsonb, 'template-hold-graph', 'template-hold-snapshot',
      'output', 'image', '[]'::jsonb, 0, null,
      'template_assets/f7b00004-1000-4000-8000-000000000004/f7d00004-1000-4000-8000-000000000004/demo/demo.png',
      timezone('utc'::text, now()))$$,
  'P0001',
  'This template was taken down by moderation and cannot be republished.',
  'so its creator cannot publish it again either'
);

-- The same publish of a template its creator disabled, with no take-down,
-- still brings it back: the refusal above is the hold, not the call.
select lives_ok(
  $$select public.activate_template_version(
      'f7d00005-1000-4000-8000-000000000005'::uuid,
      'f7b00005-1000-4000-8000-000000000005'::uuid,
      'f7a00001-1000-4000-8000-000000000001'::uuid,
      null, 1, '{}'::jsonb, 'template-hold-graph', 'template-hold-snapshot',
      'output', 'image', '[]'::jsonb, 0, null,
      'template_assets/f7b00005-1000-4000-8000-000000000005/f7d00005-1000-4000-8000-000000000005/demo/demo.png',
      timezone('utc'::text, now()))$$,
  'a template its creator disabled publishes again'
);

select is(
  (select status || '/' || is_active::text from public.templates
   where id = 'f7b00005-1000-4000-8000-000000000005'::uuid),
  'active/true',
  'and goes back into the catalog'
);

-- A report whose template is gone ------------------------------------------

insert into public.moderation_reports (id, reporter_user_id, target_type, template_id, reason, source_surface)
values ('f7c00006-1000-4000-8000-000000000006'::uuid, 'f7a00002-1000-4000-8000-000000000002'::uuid,
        'template', 'f7b00003-1000-4000-8000-000000000003'::uuid, 'spam', 'template-detail');

delete from public.templates where id = 'f7b00003-1000-4000-8000-000000000003'::uuid;

select throws_ok(
  $$select public.resolve_subject_report_for_ops(
      'f7c00006-1000-4000-8000-000000000006'::uuid,
      'f7a00004-1000-4000-8000-000000000004'::uuid,
      'resolve',
      'Nothing left to take down.'
    )$$,
  'P0002',
  null,
  'a take-down of a template that no longer exists is refused'
);

select is(
  public.resolve_subject_report_for_ops(
    'f7c00006-1000-4000-8000-000000000006'::uuid,
    'f7a00004-1000-4000-8000-000000000004'::uuid,
    'dismiss',
    'The template is gone; closing the report.'
  ) ->> 'status',
  'dismissed',
  'a report whose template is gone can still be closed'
);

select * from finish();

rollback;
