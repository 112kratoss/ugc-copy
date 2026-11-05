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

COMMIT;
