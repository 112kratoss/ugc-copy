begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

-- `generations` is deliberately not a Data API table. It exposes a narrow
-- column list to `authenticated` — the columns a client needs to resume its own
-- in-flight work — and everything else is read through the service role by the
-- API layer. A column added for the showcase grid must not quietly widen that.
--
-- Worth asserting rather than assuming: a long-lived local database can carry
-- default Data API grants that a clean migration replay never creates, so this
-- passing locally is weaker evidence than it passing in CI against a fresh
-- replay. Both run it.

select plan(6);

select ok(
  has_column_privilege('service_role', 'public.generations', 'preview_width', 'SELECT')
    and has_column_privilege('service_role', 'public.generations', 'preview_height', 'SELECT'),
  'the service layer can read the preview dimensions the showcase feed sends'
);

select ok(
  not has_column_privilege('authenticated', 'public.generations', 'preview_width', 'SELECT'),
  'signed-in Data API callers cannot read generation preview width'
);
select ok(
  not has_column_privilege('authenticated', 'public.generations', 'preview_height', 'SELECT'),
  'signed-in Data API callers cannot read generation preview height'
);
select ok(
  not has_column_privilege('anon', 'public.generations', 'preview_width', 'SELECT'),
  'anonymous Data API callers cannot read generation preview width'
);
select ok(
  not has_column_privilege('anon', 'public.generations', 'preview_height', 'SELECT'),
  'anonymous Data API callers cannot read generation preview height'
);

-- Nullable on purpose: there is no honest default for a dimension, and a row
-- whose preview has not been measured must stay distinguishable from one that
-- measured as zero. The feed sends no shape rather than a broken one.
select ok(
  (select count(*) = 2
   from information_schema.columns
   where table_schema = 'public'
     and table_name = 'generations'
     and column_name in ('preview_width', 'preview_height')
     and is_nullable = 'YES'),
  'preview dimensions stay nullable, so unmeasured is distinguishable from zero'
);

select * from finish();

rollback;
