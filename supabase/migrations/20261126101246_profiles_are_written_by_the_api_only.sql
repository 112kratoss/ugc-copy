-- Profiles are written by the API only (security audit, 2026-11-26).
--
-- Since 20260620040420 the `authenticated` role held UPDATE on ten columns of
-- public.profiles (username, display_name, bio, avatar_url, cover_url,
-- website_url, the three social handles, location), and the policy "Users can
-- update own profile." let an account change its own row. So an account could
-- PATCH /rest/v1/profiles with its own token and the public key, past
-- everything `validateProfileUpdate` (src/lib/profile.ts) holds a save to:
--
--   * the reserved handles (admin, support, official, magicbooklet, ...): the
--     only database rule on a handle is its format, so any of them was free to
--     take, and with it the look of a staff account;
--   * the website link's scheme and the avatar and cover hosts, which the pages
--     draw as they are stored;
--   * every length limit.
--
-- Nothing uses the grant. PATCH /api/profile writes with the service role
-- (`updateProfileRouteResponse` takes `createServiceClient`), no page or app
-- screen writes the table, and no shipped app version ever did. Revoking it
-- makes the API's rules the only way to a profile.
--
-- The UPDATE policies stay: without the privilege they admit nothing, and
-- removing them would be a second change to prove. A grant added back later
-- has to get past supabase/tests/database/profiles_api_only_writes.test.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';

REVOKE UPDATE (
  username, display_name, bio, avatar_url, cover_url, website_url,
  twitter_handle, instagram_handle, tiktok_handle, location
) ON TABLE public.profiles FROM authenticated, anon;

-- The table-level privilege went in 20260620040420; said again so this file
-- alone leaves no way in.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.profiles FROM authenticated, anon;

COMMIT;
