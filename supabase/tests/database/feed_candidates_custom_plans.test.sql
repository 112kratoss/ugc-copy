-- get_ranked_feed_candidates_v4 is planned for each call's own values
-- (20261118192524). The setting lives on the function, so a later CREATE OR
-- REPLACE that leaves it out would drop it without any error: this reads the
-- live function after a full replay.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(3);

create temporary table candidates_fn as
select 'public.get_ranked_feed_candidates_v4(uuid,text,text,integer,integer,integer,integer,integer,integer,double precision,double precision,timestamptz,integer,integer,integer,integer,integer,integer,double precision,integer,double precision,integer,integer,boolean,boolean)'::regprocedure as fn;

select ok(
  (select p.proconfig @> array['plan_cache_mode=force_custom_plan']
   from pg_proc as p join candidates_fn on candidates_fn.fn = p.oid),
  'the candidates function never builds a generic plan'
);
select ok(
  (select not p.prosecdef and p.proconfig @> array['search_path=public, pg_temp']
   from pg_proc as p join candidates_fn on candidates_fn.fn = p.oid),
  'and it still runs as its caller with its search path pinned'
);

-- Seven calls on one connection: the sixth is where a generic plan would be
-- built. Each must answer, and answer the same.
create temporary table candidate_calls as
select call, (
  select count(*) from public.get_ranked_feed_candidates_v4(
    p_as_of => timezone('utc'::text, now()) + (call * interval '0')
  )
) as returned
from generate_series(1, 7) as call;

select is(
  (select count(distinct returned) from candidate_calls),
  1::bigint,
  'seven calls in a row on one connection answer alike'
);

select * from finish();
rollback;
