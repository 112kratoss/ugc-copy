-- The sold-post delete guard must not block account deletion.
--
-- reject_sold_post_delete stops an owner from hard-deleting a post that has
-- purchased unlocks, so the delete path tombstones instead. But posts.user_id
-- cascades from auth.users, so deleting an account also issues a DELETE against
-- every post the account owns -- and the guard refused it. Any creator who had
-- ever sold an unlock could no longer delete their account, which is both a
-- product bug and a data-rights problem.
--
-- The two cases are distinguishable: a cascade from auth.users runs after the
-- parent row is already gone, so the owner no longer exists by the time the
-- trigger fires. An ordinary post delete always has a live owner.

CREATE OR REPLACE FUNCTION public.reject_sold_post_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Account deletion: the owner row is already gone, so this DELETE is the
  -- cascade, not a creator removing one post. Erasure wins over retention.
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.user_id) THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.post_resource_bundle_purchases AS purchases
    JOIN public.post_resource_bundles AS bundles
      ON bundles.id = purchases.bundle_id
    WHERE bundles.post_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'Post % has purchased unlocks and must be tombstoned rather than deleted', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$$;

-- The bundle-level guard needs the same exemption, for the same reason plus one
-- more. During account deletion the cascade removes the post first, then the
-- bundle; the retire path would answer that delete with an UPDATE, and the
-- bundle write validator would reject it with 'Attached post not found'. Retire
-- only makes sense while there is still a post and an owner to retire it for.
CREATE OR REPLACE FUNCTION public.retire_sold_post_resource_bundle_instead_of_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.owner_user_id)
    OR NOT EXISTS (SELECT 1 FROM public.posts WHERE id = OLD.post_id) THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.post_resource_bundle_purchases
    WHERE bundle_id = OLD.id
  ) THEN
    UPDATE public.post_resource_bundles
    SET status = 'draft',
        retired_at = coalesce(retired_at, timezone('utc'::text, now())),
        updated_at = timezone('utc'::text, now())
    WHERE id = OLD.id;

    -- Suppress the DELETE. Buyers keep their pinned revision.
    RETURN NULL;
  END IF;

  RETURN OLD;
END;
$$;
