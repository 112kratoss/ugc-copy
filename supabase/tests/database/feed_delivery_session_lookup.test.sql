-- Verify the access path exists after a clean migration replay, not only in
-- the migration text. Multiple deliveries per session must remain valid.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(1);
select ok(
  exists (
    select 1
    from pg_index i
    join pg_class idx on idx.oid = i.indexrelid
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where i.indrelid = 'public.feed_delivery_facts'::regclass
      and idx.relname = 'feed_delivery_facts_session_idx'
      and a.attname = 'session_id'
      and i.indisvalid and i.indisready and not i.indisunique
      and i.indpred is null
  ),
  'every session template lookup has a valid non-unique index with session_id first'
);
select * from finish();
rollback;
