-- A recipe becomes `published` only through a write that validated it.
--
-- 20260823130000 made the exposure sync promote every draft when its post
-- returns to public. That is right for a recipe that was published before and
-- demoted by the post leaving public -- it passed the quality gate when it was
-- listed, and a sold one is frozen besides. It is wrong for a draft that has
-- never been published: the bundle mutation RPC only runs
-- `marketplace_resource_bundle_quality_issue` when it writes `published`, so a
-- recipe saved while its post was private was never checked, and promoting it
-- on a visibility flip would publish it unchecked.
--
-- Sold recipes keep the unconditional promotion they always had. Every other
-- draft is promoted only if it passes the quality predicate now, evaluated
-- against the post's new state -- the same predicate the marketplace listing
-- applies, factored into a helper so the two cannot drift. A draft that fails
-- stays a draft; the post still changes visibility, and the recipe status the
-- RPCs return tells the client which it was.

CREATE OR REPLACE FUNCTION public.post_resource_bundle_quality_issue_for(p_bundle_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT public.marketplace_resource_bundle_quality_issue(
    bundles.title,
    bundles.summary,
    bundles.preview_text,
    bundles.prompt_text,
    bundles.notes_markdown,
    bundles.workflow_share_url,
    bundles.workflow_snapshot,
    (
      CASE
        WHEN jsonb_typeof(coalesce(bundles.attachments, '[]'::jsonb)) = 'array' THEN coalesce(bundles.attachments, '[]'::jsonb)
        ELSE '[]'::jsonb
      END
      || coalesce(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'label',
              coalesce(
                nullif(btrim(item->>'title'), ''),
                nullif(btrim(item->>'description'), ''),
                CASE coalesce(item->>'type', '')
                  WHEN 'prompt' THEN 'Prompt resource'
                  WHEN 'workflow' THEN 'Workflow resource'
                  WHEN 'reference_image' THEN 'Reference image'
                  WHEN 'reference_video' THEN 'Reference video'
                  WHEN 'reference_audio' THEN 'Reference audio'
                  WHEN 'source_file' THEN 'Source file'
                  WHEN 'preset' THEN 'Preset resource'
                  WHEN 'settings' THEN 'Settings resource'
                  WHEN 'note' THEN 'Note resource'
                  WHEN 'external_link' THEN 'External resource'
                  WHEN 'remix_access' THEN 'Remix access'
                  WHEN 'remix_link' THEN 'Remix link'
                  ELSE 'Resource item'
                END
              )
            )
          )
          FROM jsonb_array_elements(coalesce(bundles.resource_items, '[]'::jsonb)) AS item
        ),
        '[]'::jsonb
      )
    ),
    bundles.allow_remix,
    bundles.price_usd_cents,
    bundles.access_mode,
    posts.title,
    posts.body,
    posts.visibility,
    posts.archived_at,
    posts.review_status,
    (nullif(btrim(coalesce(posts.showcase_asset_path, '')), '') IS NOT NULL OR nullif(btrim(coalesce(posts.output_url, '')), '') IS NOT NULL),
    profiles.username,
    profiles.display_name
  )
  FROM public.post_resource_bundles AS bundles
  JOIN public.posts ON posts.id = bundles.post_id
  LEFT JOIN public.profiles ON profiles.id = bundles.owner_user_id
  WHERE bundles.id = p_bundle_id;
$$;

REVOKE ALL ON FUNCTION public.post_resource_bundle_quality_issue_for(uuid)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sync_post_resource_bundle_exposure()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exposed boolean := NEW.visibility = 'public' AND NEW.archived_at IS NULL;
BEGIN
  IF v_exposed THEN
    UPDATE public.post_resource_bundles AS bundles
    SET status = 'published',
        retired_at = NULL,
        updated_at = timezone('utc'::text, now())
    WHERE bundles.post_id = NEW.id
      AND bundles.owner_user_id = NEW.user_id
      AND (bundles.status IS DISTINCT FROM 'published' OR bundles.retired_at IS NOT NULL)
      AND (
        -- Sold: validated when listed, frozen since.
        EXISTS (
          SELECT 1
          FROM public.post_resource_bundle_purchases AS purchases
          WHERE purchases.bundle_id = bundles.id
            AND purchases.price_usd_cents > 0
        )
        -- Unsold: only if it would pass the gate a publishing write applies.
        OR public.post_resource_bundle_quality_issue_for(bundles.id) IS NULL
      );
  ELSE
    UPDATE public.post_resource_bundles AS bundles
    SET status = 'draft',
        updated_at = timezone('utc'::text, now())
    WHERE bundles.post_id = NEW.id
      AND bundles.owner_user_id = NEW.user_id
      AND bundles.status IS DISTINCT FROM 'draft';
  END IF;

  -- Unchanged: a linked marketplace asset that was unlisted by the post
  -- leaving public comes back only for a sold recipe on a post moderation
  -- still shows.
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
