-- The sitemap's creator list as one grouped read (database audit, 2026-11-27).
--
-- src/lib/sitemap-entries.ts read posts with .limit(20000) and no order, but the API answers at
-- most 1,000 rows (max_rows), so above 1,000 public posts the counts and "last posted" dates came
-- from an arbitrary 1,000 of them and real creators dropped out; it then read profiles with
-- .in('id', ...) carrying up to 2,000 UUIDs in the URL. This function returns, per creator, the
-- newest date of a public, visible, unarchived post, with the same gates the code applied: at
-- least p_min_posts such posts, a username, and a display name that is not blank. The newest
-- creators come first and p_limit caps the list; the caller pages it by (last_posted_at desc,
-- username), username being unique. supabase/tests/database/sitemap_creators.test.sql proves the
-- rows equal the old code's on the same data.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.list_sitemap_creators(p_min_posts integer, p_limit integer)
 RETURNS TABLE(username text, last_posted_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT pr.username, s.last_posted_at
  FROM (
    SELECT p.user_id, count(*) AS post_count, max(p.created_at) AS last_posted_at
    FROM public.posts p
    WHERE p.visibility = 'public'
      AND p.review_status = 'visible'
      AND p.archived_at IS NULL
    GROUP BY p.user_id
  ) s
  JOIN public.profiles pr ON pr.id = s.user_id
  WHERE s.post_count >= greatest(coalesce(p_min_posts, 1), 1)
    AND pr.username IS NOT NULL AND btrim(pr.username) <> ''
    AND pr.display_name IS NOT NULL AND btrim(pr.display_name) <> ''
  ORDER BY s.last_posted_at DESC, pr.username
  LIMIT greatest(coalesce(p_limit, 0), 0);
$function$;

REVOKE ALL ON FUNCTION public.list_sitemap_creators(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_sitemap_creators(integer, integer) TO service_role;

COMMIT;
