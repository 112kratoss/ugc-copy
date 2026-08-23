-- A recipe's listing status follows its post: `published` while the post is
-- public and not archived, `draft` otherwise. The demotion half of that rule
-- already ran from every writer -- both post mutation RPCs set `draft` when
-- the post leaves public, and the archive route does the same -- but only
-- SOLD bundles were ever promoted back. `sync_sold_post_resource_bundle_
-- visibility()` was scoped to purchases with a price because frozen content
-- has no other way back, and an unsold bundle was assumed to return through a
-- full editor save, which derives its status from the post's visibility.
--
-- Studio's visibility menu, the detail page, and restore all change a post's
-- exposure without an editor save. So a free recipe, or a paid one that had
-- not sold yet, stayed a draft -- off the marketplace -- after private -> public
-- or archive -> restore, until its owner happened to re-save it. Nothing in
-- the product means "draft on purpose": `apply_post_resource_bundle_mutation`
-- derives `status` from the post's visibility on every write, and removing a
-- recipe deletes its row, so promotion is always the right answer when the
-- post is exposed again. `marketplace_bundle_listings` re-runs the quality
-- gate on every status change, so a promoted bundle is only listed if it
-- still passes.
--
-- This sync now covers every bundle, both directions, on visibility and on
-- archive state. The explicit demotions in the RPCs and the archive route stay
-- as they are: they now match rows the trigger has already moved.

CREATE OR REPLACE FUNCTION public.sync_post_resource_bundle_exposure()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exposed boolean := NEW.visibility = 'public' AND NEW.archived_at IS NULL;
  v_target_status text := CASE WHEN v_exposed THEN 'published' ELSE 'draft' END;
BEGIN
  UPDATE public.post_resource_bundles AS bundles
  SET status = v_target_status,
      retired_at = CASE WHEN v_exposed THEN NULL ELSE bundles.retired_at END,
      updated_at = timezone('utc'::text, now())
  WHERE bundles.post_id = NEW.id
    AND bundles.owner_user_id = NEW.user_id
    AND (
      bundles.status IS DISTINCT FROM v_target_status
      OR (v_exposed AND bundles.retired_at IS NOT NULL)
    );

  -- Unchanged from the sold-only version: a linked marketplace asset that was
  -- unlisted by the post leaving public comes back only for a sold recipe on
  -- a post moderation still shows.
  IF v_exposed AND coalesce(NEW.review_status, 'visible') = 'visible' THEN
    UPDATE public.marketplace_assets AS assets
    SET status = 'active',
        updated_at = timezone('utc'::text, now())
    WHERE assets.post_id = NEW.id
      AND assets.seller_user_id = NEW.user_id
      AND assets.status = 'unlisted'
      AND EXISTS (
        SELECT 1
        FROM public.post_resource_bundles AS bundles
        JOIN public.post_resource_bundle_purchases AS purchases
          ON purchases.bundle_id = bundles.id
        WHERE bundles.post_id = NEW.id
          AND bundles.owner_user_id = NEW.user_id
          AND purchases.price_usd_cents > 0
      );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_post_resource_bundle_exposure()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS posts_sync_sold_resource_bundle_visibility ON public.posts;
DROP TRIGGER IF EXISTS posts_sync_resource_bundle_exposure ON public.posts;

-- No WHEN clause, like its predecessor: a write that restates the current
-- visibility still re-syncs, which heals a bundle left behind by the old gap.
CREATE TRIGGER posts_sync_resource_bundle_exposure
AFTER UPDATE OF visibility, archived_at ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.sync_post_resource_bundle_exposure();

DROP FUNCTION IF EXISTS public.sync_sold_post_resource_bundle_visibility();

-- Heal the rows the gap already left behind: a bundle that is still a draft
-- on a post that is exposed today. Sold bundles were kept in step by the old
-- trigger, so in practice these are free recipes and unsold paid ones.
UPDATE public.post_resource_bundles AS bundles
SET status = 'published',
    updated_at = timezone('utc'::text, now())
FROM public.posts
WHERE posts.id = bundles.post_id
  AND posts.user_id = bundles.owner_user_id
  AND posts.visibility = 'public'
  AND posts.archived_at IS NULL
  AND bundles.status = 'draft';
