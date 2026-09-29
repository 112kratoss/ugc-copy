-- Manual warnings only. No classifier, external API, or provider charges.
alter table public.posts add column is_nsfw boolean not null default false;
alter table public.posts add column nsfw_revision bigint not null default 1;
-- Preserve the warning on detached purchase proofs after creator deletion.
alter table public.post_resource_purchase_media add column is_nsfw boolean not null default false;

create table public.content_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  show_mature boolean not null default false,
  adult_confirmed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (not show_mature or adult_confirmed_at is not null)
);
create table public.nsfw_post_reveals (
  user_id uuid not null references auth.users(id) on delete cascade,
  post_id uuid not null references public.posts(id) on delete cascade,
  revision bigint not null,
  expires_at timestamptz not null,
  primary key(user_id, post_id)
);
create index nsfw_post_reveals_post_idx on public.nsfw_post_reveals(post_id);
alter table public.content_preferences enable row level security;
alter table public.nsfw_post_reveals enable row level security;
revoke all on public.content_preferences, public.nsfw_post_reveals from public, anon, authenticated;
grant all on public.content_preferences, public.nsfw_post_reveals to service_role;

create function public.has_nsfw_reveal(p_post_id uuid, p_viewer_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.nsfw_post_reveals r
    join public.posts p on p.id=r.post_id and p.nsfw_revision=r.revision
    join public.content_preferences c on c.user_id=r.user_id
    join public.profiles viewer on viewer.id=r.user_id
    where r.post_id=p_post_id and r.user_id=p_viewer_id and r.expires_at>now()
      and c.show_mature and c.adult_confirmed_at is not null
      and viewer.identity_state='active' and exists(select 1 from auth.users u where u.id=viewer.id and not coalesce(u.is_anonymous,false)) and p.review_status='visible'
      and p.archived_at is null and p.tombstoned_at is null
  );
$$;
revoke all on function public.has_nsfw_reveal(uuid,uuid) from public,anon,authenticated;
grant execute on function public.has_nsfw_reveal(uuid,uuid) to service_role;

create function public.reveal_nsfw_post(p_post_id uuid,p_viewer_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_post public.posts;
begin
  select * into v_post from public.posts where id=p_post_id for share;
  if not found or not v_post.is_nsfw or v_post.visibility not in ('public','unlisted')
    or v_post.review_status <> 'visible' or v_post.archived_at is not null or v_post.tombstoned_at is not null
    or not exists(select 1 from public.content_preferences c join public.profiles p on p.id=c.user_id
      where c.user_id=p_viewer_id and c.show_mature and c.adult_confirmed_at is not null and p.identity_state='active' and exists(select 1 from auth.users u where u.id=p.id and not coalesce(u.is_anonymous,false)))
    or exists(select 1 from public.user_blocks b where
      (b.blocker_user_id=p_viewer_id and b.blocked_user_id=v_post.user_id)
      or (b.blocker_user_id=v_post.user_id and b.blocked_user_id=p_viewer_id))
  then return false; end if;
  insert into public.nsfw_post_reveals(user_id,post_id,revision,expires_at)
    values(p_viewer_id,p_post_id,v_post.nsfw_revision,now()+interval '10 minutes')
    on conflict(user_id,post_id) do update set revision=excluded.revision,expires_at=excluded.expires_at;
  return true;
end;
$$;
revoke all on function public.reveal_nsfw_post(uuid,uuid) from public,anon,authenticated;
grant execute on function public.reveal_nsfw_post(uuid,uuid) to service_role;

-- A cached reveal of one revision never authorizes its replacement.
create function public.advance_nsfw_revision() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if row(new.is_nsfw,new.title,new.body,new.description,new.prompt,new.output_url,new.showcase_asset_path,new.visibility,new.review_status)
    is distinct from row(old.is_nsfw,old.title,old.body,old.description,old.prompt,old.output_url,old.showcase_asset_path,old.visibility,old.review_status)
  then new.nsfw_revision:=old.nsfw_revision+1;
  else new.nsfw_revision:=old.nsfw_revision; end if;
  return new;
end;
$$;
create trigger posts_advance_nsfw_revision before update on public.posts
for each row execute function public.advance_nsfw_revision();

create function public.advance_nsfw_media_revision() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' and row(new.storage_path,new.external_url,new.sort_order,new.preview_storage_path,new.display_storage_path,new.rendition_storage_path,new.teaser_storage_path) is not distinct from row(old.storage_path,old.external_url,old.sort_order,old.preview_storage_path,old.display_storage_path,old.rendition_storage_path,old.teaser_storage_path) then return new; end if;
  delete from public.nsfw_post_reveals where post_id=case when tg_op='DELETE' then old.post_id else new.post_id end;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create trigger post_media_invalidate_nsfw_reveals after insert or update or delete on public.post_media
for each row execute function public.advance_nsfw_media_revision();

-- These RPC wrappers retain the existing atomic bundle/media mutations. The
-- label is written within the same transaction, including old-client edits.
alter function public.upsert_post_with_resource_bundle(jsonb,jsonb,boolean) rename to upsert_post_with_resource_bundle_before_nsfw;
create function public.upsert_post_with_resource_bundle(p_post jsonb,p_bundle jsonb default null,p_has_bundle boolean default true)
returns table(post_id uuid,visibility text,bundle_id uuid,bundle_status text)
language plpgsql security definer set search_path='' as $$
declare v_result record;
begin
  if p_post ? 'is_nsfw' and jsonb_typeof(p_post->'is_nsfw') <> 'boolean' then raise exception 'Invalid NSFW label'; end if;
  select * into v_result from public.upsert_post_with_resource_bundle_before_nsfw(p_post,p_bundle,p_has_bundle);
  if p_post ? 'is_nsfw' then update public.posts set is_nsfw=(p_post->>'is_nsfw')::boolean where id=v_result.post_id; end if;
  return query select v_result.post_id::uuid,v_result.visibility::text,v_result.bundle_id::uuid,v_result.bundle_status::text;
end;
$$;
alter function public.update_post_with_resource_bundle(uuid,uuid,jsonb,boolean,jsonb) rename to update_post_with_resource_bundle_before_nsfw;
create function public.update_post_with_resource_bundle(p_post_id uuid,p_owner_user_id uuid,p_post_patch jsonb,p_has_bundle boolean default false,p_bundle jsonb default null)
returns table(post_id uuid,visibility text,bundle_id uuid,bundle_status text)
language plpgsql security definer set search_path='' as $$
declare v_result record;
begin
  if p_post_patch ? 'is_nsfw' and jsonb_typeof(p_post_patch->'is_nsfw') <> 'boolean' then raise exception 'Invalid NSFW label'; end if;
  select * into v_result from public.update_post_with_resource_bundle_before_nsfw(p_post_id,p_owner_user_id,p_post_patch,p_has_bundle,p_bundle);
  if p_post_patch ? 'is_nsfw' then update public.posts set is_nsfw=(p_post_patch->>'is_nsfw')::boolean where id=p_post_id and user_id=p_owner_user_id; end if;
  return query select v_result.post_id::uuid,v_result.visibility::text,v_result.bundle_id::uuid,v_result.bundle_status::text;
end;
$$;
revoke all on function public.upsert_post_with_resource_bundle(jsonb,jsonb,boolean),public.update_post_with_resource_bundle(uuid,uuid,jsonb,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.upsert_post_with_resource_bundle(jsonb,jsonb,boolean),public.update_post_with_resource_bundle(uuid,uuid,jsonb,boolean,jsonb) to service_role;

-- Direct Data API reads cannot bypass the warning. App projections are served
-- by the backend; originals require the explicit, expiring reveal grant.
create function public.can_read_nsfw_post(p_post_id uuid,p_viewer_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.posts p where p.id=p_post_id and
    (not p.is_nsfw or p.user_id=p_viewer_id or public.has_nsfw_reveal(p.id,p_viewer_id)));
$$;
revoke all on function public.can_read_nsfw_post(uuid,uuid) from public,anon,authenticated;
grant execute on function public.can_read_nsfw_post(uuid,uuid) to service_role;
create policy nsfw_post_read on public.posts as restrictive for select to anon,authenticated
using (not is_nsfw or user_id=(select auth.uid()));
create policy nsfw_media_read on public.post_media as restrictive for select to anon,authenticated
using (exists(select 1 from public.posts p where p.id=post_id and (not p.is_nsfw or p.user_id=(select auth.uid()))));
create policy nsfw_bundle_read on public.post_resource_bundles as restrictive for select to anon,authenticated
using (exists(select 1 from public.posts p where p.id=post_id and (not p.is_nsfw or p.user_id=(select auth.uid()))));

-- Private originals can use either the uploaded post id or generation id as
-- namespace. Membership is checked against the actual media row, not the URL.
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
        and (not p.is_nsfw or public.has_nsfw_reveal(p.id,p_viewer_id))
        and not exists(select 1 from public.user_blocks b where
          (b.blocker_user_id=p_viewer_id and b.blocked_user_id=p.user_id)
          or (b.blocker_user_id=p.user_id and b.blocked_user_id=p_viewer_id)))))
    or exists(select 1 from public.post_resource_purchase_media m
      join public.post_resource_bundle_purchases purchase on purchase.id=m.purchase_id
      left join public.post_resource_bundles bundle on bundle.id=purchase.bundle_id
      where purchase.buyer_user_id=p_viewer_id and purchase.moderation_retracted_at is null
        and ((not m.is_nsfw and bundle.post_id is null) or public.can_read_nsfw_post(bundle.post_id,p_viewer_id))
        and p_path=any(array[m.storage_path,m.preview_storage_path,m.rendition_storage_path])))
$$;

-- Prevent generation reads and public remix paths from bypassing the post.
create function public.protect_nsfw_generation_exposure() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.posts p where p.generation_id=new.id and p.is_nsfw) then
    new.is_public:=false;
    new.showcase_asset_path:=null;
  end if;
  return new;
end;
$$;
create trigger z_generations_nsfw_exposure before insert or update on public.generations
for each row execute function public.protect_nsfw_generation_exposure();
create function public.sync_nsfw_generation_exposure() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.is_nsfw and new.generation_id is not null then
    update public.generations set is_public=false,showcase_asset_path=null where id=new.generation_id;
  end if;
  return new;
end;
$$;
create trigger z_posts_nsfw_exposure after insert or update of is_nsfw,generation_id on public.posts
for each row execute function public.sync_nsfw_generation_exposure();

-- The warning must never coexist with a publicly readable media address.
-- Deferred checking lets the existing atomic gallery replacement finish first.
create function public.assert_nsfw_private_media() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_post public.posts;
begin
  if tg_table_name='posts' then v_id:=new.id; else v_id:=new.post_id; end if;
  select * into v_post from public.posts where id=v_id;
  if not found or not v_post.is_nsfw then return new; end if;
  if exists(select 1 from public.uploaded_media_private_copies c where starts_with(c.private_path,'private-posts/'||v_id::text||'/') and c.revoked_at is null)
    or (v_post.showcase_asset_path is not null and not starts_with(v_post.showcase_asset_path,'private-posts/'))
    or exists(select 1 from public.post_media m where m.post_id=v_id and
      (m.external_url is not null or exists(select 1 from unnest(array[m.storage_path,m.preview_storage_path,m.display_storage_path,m.rendition_storage_path,m.teaser_storage_path]) path where path is not null and not starts_with(path,'private-posts/'))))
  then raise exception 'NSFW_PRIVATE_MEDIA_REQUIRED'; end if;
  return new;
end;
$$;
create constraint trigger posts_nsfw_private_media after insert or update on public.posts
deferrable initially deferred for each row execute function public.assert_nsfw_private_media();
create constraint trigger post_media_nsfw_private_media after insert or update on public.post_media
deferrable initially deferred for each row execute function public.assert_nsfw_private_media();

-- Trigger helpers are not callable application APIs.
revoke all on function public.advance_nsfw_revision(),public.advance_nsfw_media_revision(),
  public.protect_nsfw_generation_exposure(),public.sync_nsfw_generation_exposure(),
  public.assert_nsfw_private_media() from public,anon,authenticated;

-- Reuse the existing durable revocation worker and immutable purchase aliases.
-- Generation covers can now move into the post's private namespace too.
alter table public.uploaded_media_private_copies drop constraint uploaded_media_private_copies_public_path_check;
alter table public.uploaded_media_private_copies drop constraint uploaded_media_private_copies_check;
alter table public.uploaded_media_private_copies add check (public_path ~ '^(posts|showcase)/[0-9a-f-]{36}/');
alter table public.uploaded_media_private_copies add check (private_path ~ '^private-posts/[0-9a-f-]{36}/');

create function public.commit_nsfw_media_private_copy(p_post_id uuid,p_owner_id uuid,p_public_path text,p_private_path text)
returns void language plpgsql security definer set search_path='' as $$
declare v_post public.posts; v_source_size bigint; v_target_size bigint;
begin
  select * into v_post from public.posts where id=p_post_id and user_id=p_owner_id for update;
  if not found then raise exception 'Post not found'; end if;
  if not starts_with(p_private_path,'private-posts/'||p_post_id::text||'/')
    or not (starts_with(p_public_path,'posts/'||p_post_id::text||'/') or coalesce(starts_with(p_public_path,'showcase/'||v_post.generation_id::text||'/'),false))
    or not (coalesce(v_post.showcase_asset_path=p_public_path,false) or exists(select 1 from public.post_media m where m.post_id=p_post_id and p_public_path=any(array[m.storage_path,m.preview_storage_path,m.display_storage_path,m.rendition_storage_path,m.teaser_storage_path])))
  then raise exception 'Invalid post media membership'; end if;
  select (metadata->>'size')::bigint into v_source_size from storage.objects where bucket_id='showcase_media' and name=p_public_path;
  select (metadata->>'size')::bigint into v_target_size from storage.objects where bucket_id='post_media' and name=p_private_path;
  if v_source_size is null or v_source_size <= 0 or v_target_size is distinct from v_source_size then raise exception 'Private copy has not been verified'; end if;
  insert into public.uploaded_media_private_copies(public_path,private_path) values(p_public_path,p_private_path)
    on conflict(public_path) do update set revoked_at=null where uploaded_media_private_copies.private_path=excluded.private_path;
  if not found then raise exception 'Conflicting private copy'; end if;
  update public.post_media set
    storage_path=case when storage_path=p_public_path then p_private_path else storage_path end,
    preview_storage_path=case when preview_storage_path=p_public_path then p_private_path else preview_storage_path end,
    display_storage_path=case when display_storage_path=p_public_path then p_private_path else display_storage_path end,
    rendition_storage_path=case when rendition_storage_path=p_public_path then p_private_path else rendition_storage_path end,
    teaser_storage_path=case when teaser_storage_path=p_public_path then p_private_path else teaser_storage_path end
    where post_id=p_post_id;
  update public.posts set showcase_asset_path=p_private_path where id=p_post_id and showcase_asset_path=p_public_path;
end;
$$;
revoke all on function public.commit_nsfw_media_private_copy(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.commit_nsfw_media_private_copy(uuid,uuid,text,text) to service_role;

create or replace function public.resolve_post_media_read(p_path text, p_viewer_id uuid)
returns text language plpgsql stable security definer set search_path='' as $$
declare v_private text;
begin
  if starts_with(p_path,'private-posts/') then
    if public.can_read_private_post_media(p_path,p_viewer_id) then return p_path; end if;
    return null;
  end if;
  if not (starts_with(p_path,'posts/') or starts_with(p_path,'showcase/')) then return null; end if;
  select private_path into v_private from public.uploaded_media_private_copies where public_path=p_path;
  if v_private is not null and public.can_read_private_post_media(v_private,p_viewer_id) then return v_private; end if;
  -- Legacy purchase snapshots, including a checkout captured after migration.
  if exists (
    select 1 from public.post_resource_purchase_media m
    join public.post_resource_bundle_purchases p on p.id=m.purchase_id
    left join public.post_resource_bundles b on b.id=p.bundle_id
    where p.buyer_user_id=p_viewer_id and p.moderation_retracted_at is null
      and ((not m.is_nsfw and b.post_id is null) or public.can_read_nsfw_post(b.post_id,p_viewer_id))
      and p_path=any(array[m.storage_path,m.preview_storage_path,m.rendition_storage_path])
  ) then return coalesce(v_private,p_path); end if;
  if not starts_with(p_path,'posts/') then return null; end if;
  -- Unmigrated rows are still readable while the bounded backfill runs.
  if exists (
    select 1 from public.posts p join public.profiles owner on owner.id=p.user_id
    where p.id=split_part(p_path,'/',2)::uuid and starts_with(p_path,'posts/' || p.id::text || '/') and owner.identity_state <> 'deleting'
    and (p.showcase_asset_path=p_path or exists(select 1 from public.post_media m where m.post_id=p.id
      and p_path=any(array[m.storage_path,m.preview_storage_path,m.display_storage_path,m.rendition_storage_path,m.teaser_storage_path])))
    and (p.user_id=p_viewer_id or (p.visibility in ('public','unlisted') and p.archived_at is null
      and p.review_status='visible' and p.tombstoned_at is null
      and public.can_read_nsfw_post(p.id,p_viewer_id)
      and not exists(select 1 from public.user_blocks b where
        (b.blocker_user_id=p_viewer_id and b.blocked_user_id=p.user_id)
        or (b.blocker_user_id=p.user_id and b.blocked_user_id=p_viewer_id))))
  ) then return coalesce(v_private,p_path); end if;
  return null;
end;
$$;
revoke all on function public.resolve_post_media_read(text,uuid) from public, anon, authenticated;
grant execute on function public.resolve_post_media_read(text,uuid) to service_role;


create function public.mark_nsfw_purchase_proof() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  new.is_nsfw:=new.is_nsfw or exists(select 1 from public.post_resource_bundle_purchases purchase
    join public.post_resource_bundles bundle on bundle.id=purchase.bundle_id
    join public.posts p on p.id=bundle.post_id where purchase.id=new.purchase_id and p.is_nsfw);
  return new;
end;
$$;
create trigger purchase_proof_nsfw before insert on public.post_resource_purchase_media
for each row execute function public.mark_nsfw_purchase_proof();
create function public.sync_nsfw_purchase_proofs() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.is_nsfw then
    update public.post_resource_purchase_media m set is_nsfw=true
    from public.post_resource_bundle_purchases purchase, public.post_resource_bundles bundle
    where m.purchase_id=purchase.id and purchase.bundle_id=bundle.id and bundle.post_id=new.id;
  end if;
  return new;
end;
$$;
create trigger posts_nsfw_purchase_proofs after update of is_nsfw on public.posts
for each row execute function public.sync_nsfw_purchase_proofs();
revoke all on function public.mark_nsfw_purchase_proof(),public.sync_nsfw_purchase_proofs() from public,anon,authenticated;

-- A historical checkout can still refer to the old generation cover. Keep its
-- verified private alias until neither a purchase nor a pending order needs it.
alter function public.private_post_media_is_referenced(text) rename to private_post_media_is_referenced_before_nsfw;
create function public.private_post_media_is_referenced(p_path text)
returns boolean language sql stable security definer set search_path='' as $$
  select public.private_post_media_is_referenced_before_nsfw(p_path)
    or exists(select 1 from public.posts p where p.showcase_asset_path=p_path)
    or exists(select 1 from public.post_media m where p_path=any(array[m.storage_path,m.preview_storage_path,m.display_storage_path,m.rendition_storage_path,m.teaser_storage_path]))
    or exists(select 1 from public.uploaded_media_private_copies c
      where c.private_path=p_path and (
        exists(select 1 from public.post_resource_purchase_media m where c.public_path=any(array[m.storage_path,m.preview_storage_path,m.rendition_storage_path]))
        or exists(select 1 from public.post_resource_bundle_orders o cross join lateral jsonb_array_elements(o.quoted_media) m
          where o.status in ('created','paid') and c.public_path=any(array[m->>'storage_path',m->>'preview_storage_path',m->>'rendition_storage_path']))));
$$;
revoke all on function public.private_post_media_is_referenced(text) from public,anon,authenticated;
grant execute on function public.private_post_media_is_referenced(text) to service_role;
