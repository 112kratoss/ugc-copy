-- A save that changes a post's title and sends no recipe takes the title of
-- the post's recipe along, unless the recipe is sold.
--
-- The recipe row keeps a copy of its post's title (`post_resource_bundles.title`):
-- the recipe panel's heading on the post page, the marketplace card and search
-- all read it. Only a save that carries the recipe writes it, through
-- apply_post_resource_bundle_mutation. A visibility change from Studio or a
-- list sends no recipe, yet since #554 it can retitle the post: a title cut
-- from the creation's prompt is stored as the recipe's kind title ("Image
-- recipe"). The post dropped the prompt's opening and its recipe kept it.
--
-- Both routes reach the two RPCs below: the publish route through
-- publish_generation_post_with_resource_bundle, the edit route directly or
-- through update_post_with_resource_bundle_and_media. They stay the wrappers
-- 20260929120000_manual_nsfw_content.sql made of them, with the title step
-- added after the save; the bodies they wrap are untouched.
--
-- A sold recipe keeps its title. The title is part of the content fingerprint
-- of the revision its buyers hold (20260801100000), and writing it raises
-- RESOURCE_BUNDLE_LOCKED, which would fail the whole save. As everywhere else,
-- only a paid purchase freezes a recipe: a free unlock holds the revision it
-- opened. A save that leaves the post's title as it was leaves the recipe's
-- alone, so a recipe with a title of its own (one made from a marketplace
-- listing by 20260406200000) keeps it until the post is retitled, as a save
-- with the recipe would.

-- Gives an unsold recipe its post's title, in the form a save with the recipe
-- writes it. The two RPCs below are its only callers.
create function public.sync_post_resource_bundle_title(p_post_id uuid, p_owner_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bundle_id uuid;
  v_title text;
begin
  -- Purchase completion takes this row lock before it records a sale, so the
  -- check below sees a sale that committed first.
  select bundles.id
  into v_bundle_id
  from public.post_resource_bundles as bundles
  where bundles.post_id = p_post_id
    and bundles.owner_user_id = p_owner_user_id
  for update;

  if v_bundle_id is null
    or exists (
      select 1
      from public.post_resource_bundle_purchases as purchases
      where purchases.bundle_id = v_bundle_id
        and purchases.price_usd_cents > 0
    ) then
    return;
  end if;

  select coalesce(nullif(btrim(posts.title), ''), 'Attached unlock')
  into v_title
  from public.posts as posts
  where posts.id = p_post_id;

  update public.post_resource_bundles as bundles
  set title = v_title,
      updated_at = timezone('utc'::text, now())
  where bundles.id = v_bundle_id
    and bundles.title is distinct from v_title;
end;
$$;

revoke all on function public.sync_post_resource_bundle_title(uuid, uuid)
  from public, anon, authenticated, service_role;

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

  select posts.title
  into v_previous_title
  from public.posts as posts
  where posts.id = p_post_id
    and posts.user_id = p_owner_user_id
  for update;

  select * into v_result from public.update_post_with_resource_bundle_before_nsfw(p_post_id, p_owner_user_id, p_post_patch, p_has_bundle, p_bundle);
  if p_post_patch ? 'is_nsfw' then update public.posts set is_nsfw = (p_post_patch->>'is_nsfw')::boolean where id = p_post_id and user_id = p_owner_user_id; end if;

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
