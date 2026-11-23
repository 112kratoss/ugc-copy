-- refund_backend_rate_limit (20261123182749): gives back one count check_backend_rate_limit made,
-- in the window named, never below zero; callable by the service role alone.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(14);

select has_function(
  'public', 'refund_backend_rate_limit', array['text', 'text', 'timestamp with time zone'],
  'the refund function exists'
);
select is_definer(
  'public', 'refund_backend_rate_limit', array['text', 'text', 'timestamp with time zone'],
  'it runs as its owner, like the check it undoes'
);
select ok(
  has_function_privilege('service_role', 'public.refund_backend_rate_limit(text, text, timestamptz)', 'EXECUTE'),
  'the service role may refund'
);
select ok(
  not has_function_privilege('authenticated', 'public.refund_backend_rate_limit(text, text, timestamptz)', 'EXECUTE'),
  'a signed-in client may not refund its own limit'
);
select ok(
  not has_function_privilege('anon', 'public.refund_backend_rate_limit(text, text, timestamptz)', 'EXECUTE'),
  'a visitor may not refund'
);

-- Two counts in this window for one subject, one for another subject, one in another scope.
do $fixture$
begin
  perform public.check_backend_rate_limit('test:refund', 'subject-a', 60, 600);
  perform public.check_backend_rate_limit('test:refund', 'subject-a', 60, 600);
  perform public.check_backend_rate_limit('test:refund', 'subject-b', 60, 600);
  perform public.check_backend_rate_limit('test:refund-other', 'subject-a', 60, 600);
end;
$fixture$;

create temporary table refund_window on commit drop as
select window_start
from public.backend_rate_limits
where scope = 'test:refund' and subject_key = 'subject-a';

select is(
  public.refund_backend_rate_limit('test:refund', 'subject-a', (select window_start from refund_window)),
  true,
  'a count in the named window is given back'
);
select is(
  (select request_count from public.backend_rate_limits where scope = 'test:refund' and subject_key = 'subject-a'),
  1,
  'one count of two is left'
);
select is(
  (select request_count from public.backend_rate_limits where scope = 'test:refund' and subject_key = 'subject-b'),
  1,
  'another subject''s count is untouched'
);
select is(
  (select request_count from public.backend_rate_limits where scope = 'test:refund-other' and subject_key = 'subject-a'),
  1,
  'the same subject''s count in another scope is untouched'
);

select is(
  public.refund_backend_rate_limit('test:refund', 'subject-a', (select window_start from refund_window) - interval '600 seconds'),
  false,
  'a window the subject has no row in gives nothing back'
);
select is(
  (select request_count from public.backend_rate_limits where scope = 'test:refund' and subject_key = 'subject-a'),
  1,
  'and leaves the named window''s count alone'
);

select is(
  public.refund_backend_rate_limit(' test:refund ', ' subject-a ', (select window_start from refund_window)),
  true,
  'scope and subject are read trimmed, as the check stores them'
);
select is(
  public.refund_backend_rate_limit('test:refund', 'subject-a', (select window_start from refund_window)),
  false,
  'a window with nothing left gives nothing back'
);
select is(
  (select request_count from public.backend_rate_limits where scope = 'test:refund' and subject_key = 'subject-a'),
  0,
  'a count never goes below zero'
);

select * from finish();
rollback;
