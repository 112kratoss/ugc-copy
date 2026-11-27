-- list_sitemap_creators: one grouped read for the sitemap's creator list (database audit,
-- 2026-11-27). It replaces a posts read the API cut at 1,000 rows and a profiles read with up to
-- 2,000 ids in its URL. Its rows must equal what the old two-step code computed when that code
-- was correct; the reference query below is that code's logic in SQL.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT plan(11);

SELECT has_function('public', 'list_sitemap_creators', ARRAY['integer', 'integer']);
SELECT is(
  (SELECT prosecdef FROM pg_proc WHERE oid = 'public.list_sitemap_creators(integer, integer)'::regprocedure),
  true, 'it is SECURITY DEFINER');
SELECT ok(NOT has_function_privilege('anon', 'public.list_sitemap_creators(integer, integer)', 'EXECUTE'), 'anon cannot call it');
SELECT ok(NOT has_function_privilege('authenticated', 'public.list_sitemap_creators(integer, integer)', 'EXECUTE'), 'authenticated cannot call it');
SELECT ok(has_function_privilege('service_role', 'public.list_sitemap_creators(integer, integer)', 'EXECUTE'), 'service_role can call it');

-- 1,205 creators: more public posts than the API's 1,000-row page, which is what the old read lost.
INSERT INTO auth.users (id, email, aud, role, created_at)
SELECT ('5a000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       'sitemap-' || n || '@example.invalid', 'authenticated', 'authenticated', '1900-01-01'
FROM generate_series(1, 1205) n;

UPDATE public.profiles p
SET username = 'smap-' || n,
    display_name = CASE
      WHEN n = 1201 THEN NULL          -- no display name: not indexable
      WHEN n = 1202 THEN '   '         -- blank display name: not indexable
      ELSE 'Creator ' || n END
FROM generate_series(1, 1205) n
WHERE p.id = ('5a000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid;
UPDATE public.profiles SET username = NULL WHERE id = '5a000000-0000-4000-8000-000000001203';

-- Every creator has one public visible post; the first 50 have a second, older one.
INSERT INTO public.posts (user_id, visibility, category, source_kind, post_format, review_status, body, created_at)
SELECT ('5a000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       'public', 'text', 'external', 'text', 'visible', 'post ' || n,
       timestamptz '2001-01-01' + make_interval(mins => n)
FROM generate_series(1, 1202) n;
INSERT INTO public.posts (user_id, visibility, category, source_kind, post_format, review_status, body, created_at)
SELECT ('5a000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       'public', 'text', 'external', 'text', 'visible', 'older ' || n, timestamptz '2000-06-01'
FROM generate_series(1, 50) n;
-- Creators 1203 to 1205 have only posts the gates exclude, and creator 1 has newer excluded ones.
INSERT INTO public.posts (user_id, visibility, category, source_kind, post_format, review_status, body, created_at, archived_at)
VALUES
  ('5a000000-0000-4000-8000-000000001203', 'public', 'text', 'external', 'text', 'visible', 'no username', '2001-02-01', NULL),
  ('5a000000-0000-4000-8000-000000001204', 'private', 'text', 'external', 'text', 'visible', 'private', '2001-02-01', NULL),
  ('5a000000-0000-4000-8000-000000001205', 'public', 'text', 'external', 'text', 'hidden', 'hidden', '2001-02-01', NULL),
  ('5a000000-0000-4000-8000-000000000001', 'public', 'text', 'external', 'text', 'visible', 'archived', '2002-01-01', '2002-01-02'),
  ('5a000000-0000-4000-8000-000000000001', 'private', 'text', 'external', 'text', 'visible', 'private', '2002-01-01', NULL);

CREATE TEMP TABLE reference_creators ON COMMIT DROP AS
WITH stats AS (
  SELECT user_id, count(*) AS post_count, max(created_at) AS last_posted_at
  FROM public.posts
  WHERE visibility = 'public' AND review_status = 'visible' AND archived_at IS NULL AND user_id IS NOT NULL
  GROUP BY user_id
)
SELECT pr.username, s.last_posted_at
FROM stats s
JOIN public.profiles pr ON pr.id = s.user_id
WHERE s.post_count >= 1
  AND pr.username IS NOT NULL AND btrim(pr.username) <> ''
  AND pr.display_name IS NOT NULL AND btrim(pr.display_name) <> '';
GRANT SELECT ON reference_creators TO service_role;

SET LOCAL role service_role;

SELECT is((SELECT count(*)::int FROM public.list_sitemap_creators(1, 2000)), 1200,
  'every creator with a public post and a name is listed, past the 1,000-row page');
SELECT set_eq(
  'SELECT username, last_posted_at FROM public.list_sitemap_creators(1, 2000)',
  'SELECT username, last_posted_at FROM reference_creators',
  'the rows equal the two-step reference: gates, counts and newest dates');
SELECT is(
  (SELECT last_posted_at FROM public.list_sitemap_creators(1, 2000) WHERE username = 'smap-1'),
  timestamptz '2001-01-01 00:01:00+00',
  'archived and private posts do not move a creator''s last posted date');
SELECT is((SELECT count(*)::int FROM public.list_sitemap_creators(2, 2000)), 50,
  'the minimum post count gates creators');
SELECT results_eq(
  'SELECT username FROM public.list_sitemap_creators(1, 3)',
  $$VALUES ('smap-1200'::text), ('smap-1199'), ('smap-1198')$$,
  'the limit keeps the creators who posted most recently');
SELECT is_empty(
  $$SELECT 1 FROM public.list_sitemap_creators(1, 2000) WHERE username IN ('smap-1201', 'smap-1202', 'smap-1204', 'smap-1205')$$,
  'no display name, a blank one, and only private or hidden posts all leave a creator out');

SELECT * FROM finish();
ROLLBACK;
