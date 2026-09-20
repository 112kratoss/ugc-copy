-- A permanent alias keeps immutable checkout quotes readable after migration.
-- Pending revocations remain durable until Storage confirms removal.
create table public.uploaded_media_private_copies (
  public_path text primary key check (public_path ~ '^posts/[0-9a-f-]{36}/'),
  private_path text not null unique check (private_path = 'private-' || public_path),
  copied_at timestamptz not null default now(),
  revoked_at timestamptz
);
-- The ledger is permanent; the worker must scan only outstanding revocations.
create index uploaded_media_private_copies_pending_idx
  on public.uploaded_media_private_copies(copied_at, public_path) where revoked_at is null;
alter table public.uploaded_media_private_copies enable row level security;
revoke all on public.uploaded_media_private_copies from public, anon, authenticated, service_role;
grant select, update on public.uploaded_media_private_copies to service_role;

create or replace function public.commit_uploaded_media_private_copy(p_public_path text)
returns void language plpgsql security definer set search_path='' as $$
declare
  v_private text := 'private-' || p_public_path;
  v_post_id uuid;
  v_source_size bigint;
  v_target_size bigint;
begin
  if p_public_path !~ '^posts/[0-9a-f-]{36}/' then raise exception 'Invalid post path'; end if;
  v_post_id := split_part(p_public_path, '/', 2)::uuid;
  -- Serialize with edits, deletion, and other copies of this post.
  perform 1 from public.posts where id=v_post_id for update;
  if not found then raise exception 'Post no longer exists'; end if;
  if exists(select 1 from public.posts p join public.profiles owner on owner.id=p.user_id
    where p.id=v_post_id and owner.identity_state='deleting') then
    raise exception 'Account deletion is in progress';
  end if;
  if exists(select 1 from public.uploaded_media_private_copies where public_path=p_public_path) then return; end if;
  select (metadata->>'size')::bigint into v_source_size from storage.objects
    where bucket_id='showcase_media' and name=p_public_path;
  select (metadata->>'size')::bigint into v_target_size from storage.objects
    where bucket_id='post_media' and name=v_private;
  if v_source_size is null or v_source_size <= 0 or v_target_size is distinct from v_source_size then
    raise exception 'Private copy has not been verified';
  end if;
  -- Never change immutable order quotes or the proof-media snapshot. The alias
  -- below resolves those exact old paths after authorization by purchase id.
  insert into public.uploaded_media_private_copies(public_path,private_path) values(p_public_path,v_private);
  update public.post_media set
    storage_path=case when storage_path=p_public_path then v_private else storage_path end,
    preview_storage_path=case when preview_storage_path=p_public_path then v_private else preview_storage_path end,
    display_storage_path=case when display_storage_path=p_public_path then v_private else display_storage_path end,
    rendition_storage_path=case when rendition_storage_path=p_public_path then v_private else rendition_storage_path end,
    teaser_storage_path=case when teaser_storage_path=p_public_path then v_private else teaser_storage_path end
  where post_id=v_post_id and p_public_path=any(array[storage_path,preview_storage_path,display_storage_path,rendition_storage_path,teaser_storage_path]);
  update public.posts set showcase_asset_path=v_private where id=v_post_id and showcase_asset_path=p_public_path;
end;
$$;
revoke all on function public.commit_uploaded_media_private_copy(text) from public, anon, authenticated;
grant execute on function public.commit_uploaded_media_private_copy(text) to service_role;

-- Private-copy lookup and current-state authorization happen in one snapshot.
create or replace function public.resolve_post_media_read(p_path text, p_viewer_id uuid)
returns text language plpgsql stable security definer set search_path='' as $$
declare v_private text;
begin
  if starts_with(p_path,'private-posts/') then
    if public.can_read_private_post_media(p_path,p_viewer_id) then return p_path; end if;
    return null;
  end if;
  if not starts_with(p_path,'posts/') then return null; end if;
  select private_path into v_private from public.uploaded_media_private_copies where public_path=p_path;
  if v_private is not null and public.can_read_private_post_media(v_private,p_viewer_id) then return v_private; end if;
  -- Legacy purchase snapshots, including a checkout captured after migration.
  if exists (
    select 1 from public.post_resource_purchase_media m
    join public.post_resource_bundle_purchases p on p.id=m.purchase_id
    where p.buyer_user_id=p_viewer_id and p.moderation_retracted_at is null
      and p_path=any(array[m.storage_path,m.preview_storage_path,m.rendition_storage_path])
  ) then return coalesce(v_private,p_path); end if;
  -- Unmigrated rows are still readable while the bounded backfill runs.
  if exists (
    select 1 from public.posts p join public.profiles owner on owner.id=p.user_id
    where p.id=split_part(p_path,'/',2)::uuid and starts_with(p_path,'posts/' || p.id::text || '/') and owner.identity_state <> 'deleting'
    and (p.showcase_asset_path=p_path or exists(select 1 from public.post_media m where m.post_id=p.id
      and p_path=any(array[m.storage_path,m.preview_storage_path,m.display_storage_path,m.rendition_storage_path,m.teaser_storage_path])))
    and (p.user_id=p_viewer_id or (p.visibility in ('public','unlisted') and p.archived_at is null
      and p.review_status='visible' and p.tombstoned_at is null
      and not exists(select 1 from public.user_blocks b where
        (b.blocker_user_id=p_viewer_id and b.blocked_user_id=p.user_id)
        or (b.blocker_user_id=p.user_id and b.blocked_user_id=p_viewer_id))))
  ) then return coalesce(v_private,p_path); end if;
  return null;
end;
$$;
revoke all on function public.resolve_post_media_read(text,uuid) from public, anon, authenticated;
grant execute on function public.resolve_post_media_read(text,uuid) to service_role;

-- Cleanup is an outbox written in the same transaction as gallery replacement
-- or deletion. An abrupt function exit cannot lose the cleanup request.
create table public.post_media_object_cleanup (
  storage_path text primary key check (storage_path ~ '^private-posts/[0-9a-f-]{36}/'),
  created_at timestamptz not null default now()
);
create index post_media_object_cleanup_oldest_idx
  on public.post_media_object_cleanup(created_at, storage_path);
alter table public.post_media_object_cleanup enable row level security;
revoke all on public.post_media_object_cleanup from public, anon, authenticated;
grant select, insert, delete on public.post_media_object_cleanup to service_role;

create or replace function public.enqueue_private_post_media_cleanup()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.post_media_object_cleanup(storage_path)
  select distinct path from unnest(array[old.storage_path,old.preview_storage_path,
    old.display_storage_path,old.rendition_storage_path,old.teaser_storage_path]) path
  where starts_with(path,'private-posts/' || old.post_id::text || '/')
  on conflict do nothing;
  return old;
end;
$$;
revoke all on function public.enqueue_private_post_media_cleanup() from public, anon, authenticated;
create trigger post_media_private_cleanup after delete on public.post_media
for each row execute function public.enqueue_private_post_media_cleanup();

create or replace function public.private_post_media_is_referenced(p_path text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.post_media m where m.post_id=split_part(p_path,'/',2)::uuid and p_path=any(array[m.storage_path,
    m.preview_storage_path,m.display_storage_path,m.rendition_storage_path,m.teaser_storage_path]))
  or exists(select 1 from public.posts p where p.id=split_part(p_path,'/',2)::uuid and p.showcase_asset_path=p_path)
  or exists(select 1 from public.post_resource_purchase_media m where
    p_path=any(array[m.storage_path,m.preview_storage_path,m.rendition_storage_path])
    or (starts_with(p_path,'private-posts/') and substring(p_path from 9)=any(array[m.storage_path,m.preview_storage_path,m.rendition_storage_path])))
  or exists(select 1 from public.post_resource_bundle_orders o
    join public.post_resource_bundles b on b.id=o.bundle_id and b.post_id=split_part(p_path,'/',2)::uuid
    cross join lateral jsonb_array_elements(o.quoted_media) m
    where o.status in ('created','paid') and (
      p_path=any(array[m->>'storage_path',m->>'preview_storage_path',m->>'rendition_storage_path'])
      or (starts_with(p_path,'private-posts/') and substring(p_path from 9)=any(array[m->>'storage_path',m->>'preview_storage_path',m->>'rendition_storage_path']))));
$$;
revoke all on function public.private_post_media_is_referenced(text) from public, anon, authenticated;
grant execute on function public.private_post_media_is_referenced(text) to service_role;
