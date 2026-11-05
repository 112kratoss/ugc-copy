-- Posting defaults (remix plan, phase 2; owner, 2026-11-05): a creation's post
-- always carries a recipe, free by default, with an "Allow remixes" switch on by
-- default, and a recipe's title needs 3 characters, no longer 6.
--
-- 1. posts.remixes_allowed: the post's own "Allow remixes", true by default and
--    for every post already there (assumption 1 of the plan: old posts stay as
--    they are). Off stops new remixes of that post only: its recipe can still be
--    claimed or bought, earlier remixes stay, and a remix of it keeps its own
--    switch (resolvePostRemixCapability, resolveRemixAccess). It is not the
--    stored post_resource_bundles.allow_remix, which hands the creation's live
--    inputs to a recipe's buyers (post-resource-bundles-server.ts) and which a
--    composer's remove buttons and the old "own uploads" rule wrote false on
--    published recipes: honouring it here would close those posts silently.
-- 2. The two save RPCs (20261026150925) write it when the save sends it, as they
--    write is_nsfw: validated as a boolean, after the save, in its transaction.
--    Their bodies are otherwise unchanged.
-- 3. marketplace_resource_bundle_quality_issue (20260723120000) reads the title
--    minimum as 3, the shared RECIPE_TITLE_MIN_LENGTH
--    (ugc-mobile/lib/post-publish-policy/), held equal by
--    src/__tests__/marketplace-trust.test.ts. Its body is otherwise unchanged.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS remixes_allowed boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN public.posts.remixes_allowed IS
  'The post''s own "Allow remixes" (owner, 2026-11-05): off stops new remixes of this post only. Not post_resource_bundles.allow_remix, which hands the creation''s inputs to buyers.';

create or replace function public.upsert_post_with_resource_bundle(
  p_post jsonb,
  p_bundle jsonb default null,
  p_has_bundle boolean default true
)
returns table(post_id uuid, visibility text, bundle_id uuid, bundle_status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result record;
  v_owner_user_id uuid := nullif(p_post->>'user_id', '')::uuid;
  v_existing_post_id uuid := nullif(p_post->>'id', '')::uuid;
  v_existed boolean;
  v_previous_title text;
  v_title text;
begin
  if p_post ? 'is_nsfw' and jsonb_typeof(p_post->'is_nsfw') <> 'boolean' then raise exception 'Invalid NSFW label'; end if;
  if p_post ? 'remixes_allowed' and jsonb_typeof(p_post->'remixes_allowed') <> 'boolean' then raise exception 'Invalid remix switch'; end if;

  -- The post this save updates, found as the upsert finds it, and its title
  -- before the save.
  if v_existing_post_id is null and nullif(p_post->>'generation_id', '') is not null then
    select posts.id
    into v_existing_post_id
    from public.posts as posts
    where posts.generation_id = (p_post->>'generation_id')::uuid;
  end if;

  select posts.title
  into v_previous_title
  from public.posts as posts
  where posts.id = v_existing_post_id
    and posts.user_id = v_owner_user_id
  for update;
  v_existed := found;

  select * into v_result from public.upsert_post_with_resource_bundle_before_nsfw(p_post, p_bundle, p_has_bundle);
  if p_post ? 'is_nsfw' then update public.posts set is_nsfw = (p_post->>'is_nsfw')::boolean where id = v_result.post_id; end if;
  if p_post ? 'remixes_allowed' then update public.posts set remixes_allowed = (p_post->>'remixes_allowed')::boolean where id = v_result.post_id; end if;

  -- A recipe sent with the save took the post's title in the save itself.
  if p_has_bundle is not true and v_existed then
    select posts.title into v_title from public.posts as posts where posts.id = v_result.post_id;
    if v_title is distinct from v_previous_title then
      perform public.sync_post_resource_bundle_title(v_result.post_id, v_owner_user_id);
    end if;
  end if;

  return query select v_result.post_id::uuid, v_result.visibility::text, v_result.bundle_id::uuid, v_result.bundle_status::text;
end;
$$;

create or replace function public.update_post_with_resource_bundle(
  p_post_id uuid,
  p_owner_user_id uuid,
  p_post_patch jsonb,
  p_has_bundle boolean default false,
  p_bundle jsonb default null
)
returns table(post_id uuid, visibility text, bundle_id uuid, bundle_status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result record;
  v_previous_title text;
  v_title text;
begin
  if p_post_patch ? 'is_nsfw' and jsonb_typeof(p_post_patch->'is_nsfw') <> 'boolean' then raise exception 'Invalid NSFW label'; end if;
  if p_post_patch ? 'remixes_allowed' and jsonb_typeof(p_post_patch->'remixes_allowed') <> 'boolean' then raise exception 'Invalid remix switch'; end if;

  select posts.title
  into v_previous_title
  from public.posts as posts
  where posts.id = p_post_id
    and posts.user_id = p_owner_user_id
  for update;

  select * into v_result from public.update_post_with_resource_bundle_before_nsfw(p_post_id, p_owner_user_id, p_post_patch, p_has_bundle, p_bundle);
  if p_post_patch ? 'is_nsfw' then update public.posts set is_nsfw = (p_post_patch->>'is_nsfw')::boolean where id = p_post_id and user_id = p_owner_user_id; end if;
  if p_post_patch ? 'remixes_allowed' then update public.posts set remixes_allowed = (p_post_patch->>'remixes_allowed')::boolean where id = p_post_id and user_id = p_owner_user_id; end if;

  -- A recipe sent with the save took the post's title in the save itself.
  if p_has_bundle is not true then
    select posts.title into v_title from public.posts as posts where posts.id = p_post_id;
    if v_title is distinct from v_previous_title then
      perform public.sync_post_resource_bundle_title(p_post_id, p_owner_user_id);
    end if;
  end if;

  return query select v_result.post_id::uuid, v_result.visibility::text, v_result.bundle_id::uuid, v_result.bundle_status::text;
end;
$$;

revoke all on function public.upsert_post_with_resource_bundle(jsonb, jsonb, boolean)
  from public, anon, authenticated;
revoke all on function public.update_post_with_resource_bundle(uuid, uuid, jsonb, boolean, jsonb)
  from public, anon, authenticated;
grant execute on function public.upsert_post_with_resource_bundle(jsonb, jsonb, boolean)
  to service_role;
grant execute on function public.update_post_with_resource_bundle(uuid, uuid, jsonb, boolean, jsonb)
  to service_role;

CREATE OR REPLACE FUNCTION public.marketplace_resource_bundle_quality_issue(
  p_title text,
  p_summary text,
  p_preview_text text,
  p_prompt_text text,
  p_notes_markdown text,
  p_workflow_share_url text,
  p_workflow_snapshot jsonb,
  p_attachments jsonb,
  p_allow_remix boolean,
  p_price_usd_cents integer,
  p_access_mode text,
  p_post_title text,
  p_post_body text,
  p_post_visibility text,
  p_post_archived_at timestamptz,
  p_post_review_status text,
  p_post_has_media boolean,
  p_seller_username text,
  p_seller_display_name text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_title text := btrim(coalesce(p_title, ''));
  v_summary text := btrim(coalesce(p_summary, ''));
  v_preview text := btrim(coalesce(nullif(p_summary, ''), p_preview_text, ''));
  v_post_title text := btrim(coalesce(p_post_title, ''));
  v_post_body text := btrim(coalesce(p_post_body, ''));
  v_username text := btrim(coalesce(p_seller_username, ''));
  v_display_name text := btrim(coalesce(p_seller_display_name, ''));
  v_attachments jsonb := CASE
    WHEN jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) = 'array' THEN coalesce(p_attachments, '[]'::jsonb)
    ELSE '[]'::jsonb
  END;
  v_has_resource boolean;
  v_has_creator boolean;
BEGIN
  IF v_title = '' OR length(v_title) < 3 THEN
    RETURN 'Add a clear listing title with at least 3 characters.';
  END IF;

  IF public.marketplace_text_is_placeholder(v_title) THEN
    RETURN 'Replace the placeholder listing title with a specific buyer-facing title.';
  END IF;

  IF v_preview = '' OR length(v_preview) < 18 OR public.marketplace_text_is_placeholder(v_preview) THEN
    RETURN 'Add a useful preview or summary that tells buyers what they will unlock.';
  END IF;

  SELECT
    (
      (nullif(btrim(coalesce(p_prompt_text, '')), '') IS NOT NULL AND length(btrim(coalesce(p_prompt_text, ''))) >= 20 AND NOT public.marketplace_text_is_placeholder(p_prompt_text))
      OR (nullif(btrim(coalesce(p_notes_markdown, '')), '') IS NOT NULL AND length(btrim(coalesce(p_notes_markdown, ''))) >= 20 AND NOT public.marketplace_text_is_placeholder(p_notes_markdown))
      OR nullif(btrim(coalesce(p_workflow_share_url, '')), '') IS NOT NULL
      OR p_workflow_snapshot IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_attachments) AS attachment
        WHERE length(btrim(coalesce(attachment->>'label', ''))) >= 4
          AND NOT public.marketplace_text_is_placeholder(attachment->>'label')
      )
      OR coalesce(p_allow_remix, false)
    )
  INTO v_has_resource;

  IF NOT coalesce(v_has_resource, false) THEN
    RETURN 'Attach at least one useful prompt, workflow, file, note, or remix permission.';
  END IF;

  IF p_access_mode = 'paid'
    AND (
      coalesce(p_price_usd_cents, 0) < 10
      OR coalesce(p_price_usd_cents, 0) % 10 <> 0
    ) THEN
    RETURN 'Paid unlocks must cost at least 10 tokens and use 10-token increments.';
  END IF;

  IF p_post_visibility IS DISTINCT FROM 'public'
    OR p_post_archived_at IS NOT NULL
    OR coalesce(p_post_review_status, 'visible') = 'hidden' THEN
    RETURN 'Publish a visible public post before listing this unlock in the marketplace.';
  END IF;

  IF NOT (
    coalesce(p_post_has_media, false)
    OR (length(v_post_body) >= 24 AND NOT public.marketplace_text_is_placeholder(v_post_body))
    OR (length(v_post_title) >= 12 AND NOT public.marketplace_text_is_placeholder(v_post_title))
  ) THEN
    RETURN 'Add useful public post content or media so buyers can judge the result before unlocking.';
  END IF;

  v_has_creator :=
    (
      length(v_username) >= 3
      AND lower(v_username) NOT IN ('anonymous', 'creator', 'magicbooklet', 'unknown', 'user')
      AND NOT public.marketplace_text_is_placeholder(v_username)
    )
    OR (
      length(v_display_name) >= 3
      AND lower(v_display_name) NOT IN ('anonymous', 'creator', 'magicbooklet', 'unknown', 'user')
      AND NOT public.marketplace_text_is_placeholder(v_display_name)
    );

  IF NOT v_has_creator THEN
    RETURN 'Complete your creator profile name or username before publishing a marketplace unlock.';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.marketplace_resource_bundle_quality_issue(text, text, text, text, text, text, jsonb, jsonb, boolean, integer, text, text, text, text, timestamptz, text, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.marketplace_resource_bundle_quality_issue(text, text, text, text, text, text, jsonb, jsonb, boolean, integer, text, text, text, text, timestamptz, text, boolean, text, text) TO service_role;

-- 4. A post whose creator turned "Allow remixes" off sells no Remix with its recipe (the review of
--    phase 2): the marketplace's Remix filter (`has_remix`) and its search text no longer count
--    one there. The two refreshes are 20261101072014's, but for the call of
--    post_resource_bundle_kinds, which now reads the post's switch; both posts triggers watch it.
--    Every post allows remixes when this runs, so no listing changes until a switch does.
CREATE OR REPLACE FUNCTION public.refresh_marketplace_bundle_search_documents(
  p_bundle_ids uuid[] DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  INSERT INTO public.marketplace_bundle_search_documents AS documents (bundle_id, search_text)
  SELECT
    bundles.id,
    lower(concat_ws(
      ' ',
      CASE
        WHEN lower(btrim(coalesce(bundles.title, ''))) IN ('', 'attached unlock') THEN 'Recipe'
        ELSE btrim(bundles.title)
      END,
      nullif(bundles.summary, ''),
      nullif(bundles.preview_text, ''),
      nullif(profiles.username, ''),
      coalesce(nullif(btrim(profiles.display_name), ''), nullif(btrim(profiles.username), ''), 'Creator'),
      nullif(btrim(posts.title), ''),
      nullif(btrim(public.recipe_post_public_body(posts.body, bundles.access_mode)), ''),
      nullif(posts.source_tool, ''),
      nullif(array_to_string(public.post_resource_bundle_kinds(
        bundles.resource_items,
        bundles.allow_remix AND coalesce(posts.remixes_allowed, true),
        bundles.status,
        CASE WHEN coalesce(posts.remixes_allowed, true) THEN posts.generation_id END
      ), ' '), '')
    ))
  FROM public.post_resource_bundles AS bundles
  LEFT JOIN public.posts AS posts ON posts.id = bundles.post_id
  LEFT JOIN public.profiles AS profiles ON profiles.id = bundles.owner_user_id
  WHERE p_bundle_ids IS NULL OR bundles.id = ANY (p_bundle_ids)
  ON CONFLICT (bundle_id) DO UPDATE SET search_text = excluded.search_text
  WHERE documents.search_text IS DISTINCT FROM excluded.search_text;
$function$;

REVOKE ALL ON FUNCTION public.refresh_marketplace_bundle_search_documents(uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_marketplace_bundle_search_documents(uuid[])
  TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_marketplace_bundle_listings(
  p_bundle_ids uuid[] DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  INSERT INTO public.marketplace_bundle_listings AS listings (
    bundle_id, listable, created_at, sales_count, price_usd_cents,
    access_mode, tool_slug, has_prompt, has_workflow, has_files, has_notes, has_remix
  )
  SELECT
    bundles.id,
    (
      posts.id IS NOT NULL
      AND bundles.status = 'published'
      AND posts.visibility = 'public'
      AND posts.archived_at IS NULL
      AND coalesce(posts.review_status, 'visible') = 'visible'
      AND posts.is_nsfw = false
      AND public.marketplace_resource_bundle_quality_issue(
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
      ) IS NULL
    ),
    bundles.created_at,
    bundles.sales_count,
    bundles.price_usd_cents,
    bundles.access_mode,
    coalesce(
      nullif(posts.source_tool_slug, ''),
      lower(regexp_replace(btrim(coalesce(posts.source_tool, '')), '[^a-z0-9]+', '-', 'g'))
    ),
    -- The five filter flags: the kinds the recipe's card shows.
    'prompt' = ANY (resource.kinds),
    'workflow' = ANY (resource.kinds),
    'files' = ANY (resource.kinds),
    'notes' = ANY (resource.kinds),
    'remix' = ANY (resource.kinds)
  FROM public.post_resource_bundles bundles
  LEFT JOIN public.posts posts ON posts.id = bundles.post_id
  LEFT JOIN public.profiles profiles ON profiles.id = bundles.owner_user_id
  CROSS JOIN LATERAL public.post_resource_bundle_kinds(
    bundles.resource_items,
    bundles.allow_remix AND coalesce(posts.remixes_allowed, true),
    bundles.status,
    CASE WHEN coalesce(posts.remixes_allowed, true) THEN posts.generation_id END
  ) AS resource(kinds)
  WHERE p_bundle_ids IS NULL OR bundles.id = ANY (p_bundle_ids)
  ON CONFLICT (bundle_id) DO UPDATE SET
    listable = excluded.listable,
    created_at = excluded.created_at,
    sales_count = excluded.sales_count,
    price_usd_cents = excluded.price_usd_cents,
    access_mode = excluded.access_mode,
    tool_slug = excluded.tool_slug,
    has_prompt = excluded.has_prompt,
    has_workflow = excluded.has_workflow,
    has_files = excluded.has_files,
    has_notes = excluded.has_notes,
    has_remix = excluded.has_remix
  -- Assigns, never accumulates, and skips no-op writes so a re-run is free.
  WHERE listings.* IS DISTINCT FROM excluded.*;
$function$;

REVOKE ALL ON FUNCTION public.refresh_marketplace_bundle_listings(uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_marketplace_bundle_listings(uuid[])
  TO service_role;

-- Every post column the search document reads (20261031100330), the switch now among them.
CREATE OR REPLACE TRIGGER posts_refresh_marketplace_search
  AFTER UPDATE ON public.posts
  FOR EACH ROW
  WHEN (
    OLD.title IS DISTINCT FROM NEW.title
    OR OLD.body IS DISTINCT FROM NEW.body
    OR OLD.source_tool IS DISTINCT FROM NEW.source_tool
    OR OLD.generation_id IS DISTINCT FROM NEW.generation_id
    OR OLD.remixes_allowed IS DISTINCT FROM NEW.remixes_allowed
  )
  EXECUTE FUNCTION public.trg_refresh_marketplace_search_for_post();

-- Every post column the listing reads (20261101072014), the switch now among them.
CREATE OR REPLACE TRIGGER posts_refresh_marketplace_listing
  AFTER UPDATE ON public.posts
  FOR EACH ROW
  WHEN (
    OLD.visibility IS DISTINCT FROM NEW.visibility
    OR OLD.archived_at IS DISTINCT FROM NEW.archived_at
    OR OLD.review_status IS DISTINCT FROM NEW.review_status
    OR OLD.title IS DISTINCT FROM NEW.title
    OR OLD.body IS DISTINCT FROM NEW.body
    OR OLD.showcase_asset_path IS DISTINCT FROM NEW.showcase_asset_path
    OR OLD.output_url IS DISTINCT FROM NEW.output_url
    OR OLD.source_tool_slug IS DISTINCT FROM NEW.source_tool_slug
    OR OLD.source_tool IS DISTINCT FROM NEW.source_tool
    OR OLD.is_nsfw IS DISTINCT FROM NEW.is_nsfw
    OR OLD.generation_id IS DISTINCT FROM NEW.generation_id
    OR OLD.remixes_allowed IS DISTINCT FROM NEW.remixes_allowed
  )
  EXECUTE FUNCTION public.trg_refresh_marketplace_listing_for_post();

-- 5. A recipe titled 3 to 5 characters is listable from here on (3 above): re-project those listings,
--    as a retitled post's recipe may have been held back by the old minimum. Only rows whose values
--    change are written.
SELECT public.refresh_marketplace_bundle_listings(ARRAY(
  SELECT bundles.id
  FROM public.post_resource_bundles AS bundles
  WHERE length(btrim(coalesce(bundles.title, ''))) BETWEEN 3 AND 5
));

COMMIT;
