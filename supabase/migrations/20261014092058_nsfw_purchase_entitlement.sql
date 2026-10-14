-- A purchase is the entitlement. A buyer reads the media of a mature post they
-- unlocked -- the library thumbnail, the unlock's cover, the purchase snapshot --
-- without the ten-minute reveal a passing viewer needs, and whatever their
-- "show mature content" preference says. The clients cover that media with an
-- in-place "Show" plate, which is the per-view consent; the resource files were
-- already signed straight from storage for a confirmed buyer, so only the proxy
-- stood in the way (2026-10-14 Studio comparison, finding 03-1).
-- Nothing changes for a viewer without a purchase: the reveal gate and the
-- blocks stand as 20260929120000 wrote them. A retracted purchase grants nothing.
create or replace function public.can_read_nsfw_post(p_post_id uuid,p_viewer_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.posts p where p.id=p_post_id and
    (not p.is_nsfw or p.user_id=p_viewer_id or public.has_nsfw_reveal(p.id,p_viewer_id)
     or exists(select 1 from public.post_resource_bundle_purchases purchase
       join public.post_resource_bundles bundle on bundle.id=purchase.bundle_id
       where bundle.post_id=p.id and purchase.buyer_user_id=p_viewer_id
         and purchase.moderation_retracted_at is null)));
$$;
revoke all on function public.can_read_nsfw_post(uuid,uuid) from public,anon,authenticated;
grant execute on function public.can_read_nsfw_post(uuid,uuid) to service_role;

-- The live-post branch asked has_nsfw_reveal directly, so a buyer's own cover
-- (the post's preview) was refused while their files opened. It now asks the
-- same question as every other media read. The snapshot branch no longer needs
-- the snapshot's own flag: the buyer named in the purchase row is the reader.
create or replace function public.can_read_private_post_media(p_path text,p_viewer_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select starts_with(p_path,'private-posts/') and (
    exists(select 1 from public.posts p join public.profiles owner on owner.id=p.user_id
      where (p.id=split_part(p_path,'/',2)::uuid or p.generation_id=split_part(p_path,'/',2)::uuid)
      and owner.identity_state not in ('deleting','deleted','merged')
      and (p.showcase_asset_path=p_path or exists(select 1 from public.post_media m where m.post_id=p.id
        and p_path=any(array[m.storage_path,m.preview_storage_path,m.display_storage_path,m.rendition_storage_path,m.teaser_storage_path])))
      and (p.user_id=p_viewer_id or (p.visibility in ('public','unlisted') and p.archived_at is null
        and p.review_status='visible' and p.tombstoned_at is null
        and public.can_read_nsfw_post(p.id,p_viewer_id)
        and not exists(select 1 from public.user_blocks b where
          (b.blocker_user_id=p_viewer_id and b.blocked_user_id=p.user_id)
          or (b.blocker_user_id=p.user_id and b.blocked_user_id=p_viewer_id)))))
    or exists(select 1 from public.post_resource_purchase_media m
      join public.post_resource_bundle_purchases purchase on purchase.id=m.purchase_id
      left join public.post_resource_bundles bundle on bundle.id=purchase.bundle_id
      where purchase.buyer_user_id=p_viewer_id and purchase.moderation_retracted_at is null
        and (bundle.post_id is null or public.can_read_nsfw_post(bundle.post_id,p_viewer_id))
        and p_path=any(array[m.storage_path,m.preview_storage_path,m.rendition_storage_path])))
$$;
revoke all on function public.can_read_private_post_media(text,uuid) from public,anon,authenticated;
grant execute on function public.can_read_private_post_media(text,uuid) to service_role;
