-- A buyer's use of a recipe's files ends with their unlock, and a removed or
-- archived creation's copies stop being served (owner, 2026-11-04).
--
-- A buyer holds a seller's files two ways once a remix of a recipe they bought
-- has run: the run start's import of a copy
-- (generation_inputs/<buyer>/recipe-imports/<seller>/<creation>/<file>) and the
-- run's kept input (generation_inputs/<buyer>/<run>/NN-role.ext), whose
-- generation_input_media row is marked as a recipe file
-- (src/lib/generation-input-origin.ts). Both sit in the buyer's own folder, so
-- "Users can read own generation inputs" let them read both with their own JWT
-- for good: a refund that deleted the purchase, or the seller archiving the
-- creation, took nothing back. Every server use re-checked the unlock; a direct
-- read did not.
--
-- 1. public.recipe_file_readable_by(viewer, path): may this viewer read this
--    recipe file now. Their own files always; anyone else's only through a
--    purchase that is not retracted, whose recipe as it stands or whose bought
--    version (with its supplement) still lists the file, and, for a copy of a
--    creation's input (<seller>/generation-references/<creation>/<file>), only
--    while that creation is neither removed nor archived (the two marks
--    creationMayShareRecipe reads; a creation deleted outright keeps its post
--    serving, as posts.deleted_generation_id has it). The server asks it in a
--    batch (recipe_files_readable_by) before signing a held file.
-- 2. "Users can read own generation inputs" keeps the owner's folder and adds
--    generation_input_object_readable(name): never a run start's import (only
--    the server reads those, after its own check), and a kept input marked as a
--    recipe file only while the predicate above says so. A refund, a retracted
--    purchase or an archive closes the file; a restored purchase or an
--    un-archive opens it again, since nothing is deleted.
-- 3. public.seedance_prepared_assets records which account prepared each
--    Seedance asset and from what (src/lib/seedance-asset-provenance.ts). An
--    asset id is a bearer handle at the provider, so a start refuses one
--    prepared from a recipe file the caller can no longer use. The table is
--    backfilled from the asset ids every run so far recorded
--    (workflow_settings.seedanceAssets), each under the first account that ran
--    it and classified by the file it ran in place of.

-- ─── Which recipe file a held file stands for ───────────────────────────────

-- The recipe file a source names, as post_resource_files/<seller>/<path>: a
-- seller's file itself where the seller is not the holder, or a run start's
-- import of a copy, in anyone's folder. Null for anything else. As a storage
-- path or a storage URL (src/lib/recipe-file-paths.ts, recipeCopyOfSource and
-- isRecipeFileSource, read the same two shapes).
create or replace function public.recipe_file_of_source(p_holder_user_id uuid, p_source text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when parsed.recipe_file is not null and parsed.recipe_file[1] <> coalesce(p_holder_user_id::text, '')
      then 'post_resource_files/' || parsed.recipe_file[1] || '/' || parsed.recipe_file[2]
    when parsed.import is not null
      then 'post_resource_files/' || parsed.import[1] || '/generation-references/' || parsed.import[2] || '/' || parsed.import[3]
  end
  from (
    select
      regexp_match(
        coalesce(p_source, ''),
        '^(?:https?://[^/?#]+/storage/v1/object/(?:sign|public|authenticated)/)?post_resource_files/([^/?#]+)/([^?#]+)'
      ) as recipe_file,
      regexp_match(
        coalesce(p_source, ''),
        '^(?:https?://[^/?#]+/storage/v1/object/(?:sign|public|authenticated)/)?generation_inputs/[^/?#]+/recipe-imports/([^/?#]+)/([^/?#]+)/([^/?#]+)(?:[?#].*)?$'
      ) as import
  ) parsed;
$$;

-- The recipe file a kept input stands for (isRecipeFileInput, recipeFileCopyOf):
-- the copy its row recorded, or the one its sources name. '' for a row marked
-- as a recipe file whose file is on no record, which nobody may read but the
-- server; null for an input of the holder's own.
create or replace function public.held_input_recipe_file(p_holder_user_id uuid, p_metadata jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    public.recipe_file_of_source(p_holder_user_id, p_metadata ->> 'recipeFile'),
    public.recipe_file_of_source(p_holder_user_id, p_metadata ->> 'sourceStoragePath'),
    public.recipe_file_of_source(p_holder_user_id, p_metadata ->> 'sourceUrl'),
    case when p_metadata ->> 'sourceKind' = 'recipe-file' then '' end
  );
$$;

-- ─── May this viewer read this recipe file now ──────────────────────────────

create or replace function public.recipe_file_readable_by(p_viewer_user_id uuid, p_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with file as (
    select regexp_replace(coalesce(p_path, ''), '^post_resource_files/', '') as path
  ), parts as (
    select
      path,
      split_part(path, '/', 1) as seller,
      split_part(path, '/', 2) as folder,
      case
        when split_part(path, '/', 3) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then split_part(path, '/', 3)::uuid
      end as creation_id,
      jsonb_build_array(jsonb_build_object('storagePath', path)) as bare_item,
      jsonb_build_array(jsonb_build_object('storagePath', 'post_resource_files/' || path)) as prefixed_item
    from file
  )
  select coalesce((
    select p_viewer_user_id is not null
      and parts.seller <> ''
      and (
        parts.seller = p_viewer_user_id::text
        or (
          -- A copy of a creation its operator removed or its creator archived.
          not exists (
            select 1
            from public.generations creation
            where parts.folder = 'generation-references'
              and creation.id = parts.creation_id
              and (creation.archived_at is not null or creation.moderation_removed_at is not null)
          )
          and exists (
            select 1
            from public.post_resource_bundle_purchases purchase
            where purchase.buyer_user_id = p_viewer_user_id
              and purchase.moderation_retracted_at is null
              and (
                exists (
                  select 1
                  from public.post_resource_bundles bundle
                  where bundle.id = purchase.bundle_id
                    and bundle.owner_user_id::text = parts.seller
                    and (
                      bundle.resource_items @> parts.bare_item
                      or bundle.resource_items @> parts.prefixed_item
                      or bundle.attachments @> parts.bare_item
                      or bundle.attachments @> parts.prefixed_item
                    )
                )
                or exists (
                  select 1
                  from public.post_resource_bundle_revisions revision
                  where revision.id = purchase.revision_id
                    and (
                      revision.resource_items @> parts.bare_item
                      or revision.resource_items @> parts.prefixed_item
                      or revision.attachments @> parts.bare_item
                      or revision.attachments @> parts.prefixed_item
                    )
                )
                or exists (
                  select 1
                  from public.post_resource_bundle_revision_supplements supplement
                  where supplement.revision_id = purchase.revision_id
                    and (
                      supplement.resource_items @> parts.bare_item
                      or supplement.resource_items @> parts.prefixed_item
                    )
                )
              )
          )
        )
      )
    from parts
  ), false);
$$;

-- The server's batch: those of the paths the viewer may read now, as given.
create or replace function public.recipe_files_readable_by(p_viewer_user_id uuid, p_paths text[])
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct requested.path), '{}'::text[])
  from unnest(coalesce(p_paths, '{}'::text[])) as requested(path)
  where public.recipe_file_readable_by(p_viewer_user_id, requested.path);
$$;

-- ─── The generation_inputs read policy ──────────────────────────────────────

-- Whether the signed-in caller may read an object of their own generation
-- inputs: anything but a run start's import, and a kept input marked as a
-- recipe file only while its recipe file is theirs to read. The kept input is
-- found by the run its path names (generation_input_media_generation_order_idx).
create or replace function public.generation_input_object_readable(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when (select auth.uid()) is null
      or split_part(coalesce(p_name, ''), '/', 1) <> (select auth.uid())::text
      then false
    when split_part(p_name, '/', 2) = 'recipe-imports' then false
    else not exists (
      select 1
      from public.generation_input_media kept
      cross join lateral (select public.held_input_recipe_file(kept.user_id, kept.metadata) as file) held
      where kept.generation_id = case
          when split_part(p_name, '/', 2) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then split_part(p_name, '/', 2)::uuid
        end
        and kept.storage_path = 'generation_inputs/' || p_name
        and held.file is not null
        and (held.file = '' or not public.recipe_file_readable_by(kept.user_id, held.file))
    )
  end;
$$;

revoke all on function public.recipe_file_of_source(uuid, text) from public, anon, authenticated;
revoke all on function public.held_input_recipe_file(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.recipe_file_readable_by(uuid, text) from public, anon, authenticated;
revoke all on function public.recipe_files_readable_by(uuid, text[]) from public, anon, authenticated;
revoke all on function public.generation_input_object_readable(text) from public, anon, authenticated;
grant execute on function public.recipe_file_of_source(uuid, text) to service_role;
grant execute on function public.held_input_recipe_file(uuid, jsonb) to service_role;
grant execute on function public.recipe_file_readable_by(uuid, text) to service_role;
grant execute on function public.recipe_files_readable_by(uuid, text[]) to service_role;
-- The read policy runs it as the caller; it answers only of the caller's own folder.
grant execute on function public.generation_input_object_readable(text) to authenticated, service_role;

-- ─── Seedance assets: who prepared each, and from what ──────────────────────

create table public.seedance_prepared_assets (
  -- The provider's handle, as a start sends it (PROVIDER_ASSET_HANDLE_PATTERN).
  asset_id text primary key check (asset_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$'),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  -- The file it was prepared from, as the caller named it.
  source text not null,
  -- The recipe file that file stands for (post_resource_files/<seller>/...),
  -- '' for one marked as a recipe file whose file is on no record, null for the
  -- owner's own file.
  recipe_file text check (recipe_file is null or recipe_file = '' or recipe_file like 'post_resource_files/%'),
  -- prepare: the asset route; run: this backfill; start: the first start that
  -- sent an id prepared before this table, paired with its file.
  recorded_from text not null check (recorded_from in ('prepare', 'run', 'start')),
  created_at timestamptz not null default timezone('utc'::text, now())
);

create index seedance_prepared_assets_owner_idx on public.seedance_prepared_assets (owner_user_id);

alter table public.seedance_prepared_assets enable row level security;

revoke all on table public.seedance_prepared_assets from public, anon, authenticated;
-- A record is written once and never rewritten; an account's go with it.
revoke update, delete, truncate on table public.seedance_prepared_assets from service_role;
grant select, insert on table public.seedance_prepared_assets to service_role;

comment on table public.seedance_prepared_assets is
  'Which account prepared each Seedance asset and from which file. A start refuses an asset prepared from a recipe file the caller cannot use now (src/lib/seedance-asset-provenance.ts).';

-- The asset ids every run so far recorded (workflow_settings.seedanceAssets),
-- each under the first account that ran it and classified by the file it ran
-- in place of: the seller's file itself, a run start's import of a copy, or a
-- kept input of the runner's own marked as a recipe file. Owner only (below).
-- Idempotent: a second
-- call adds only what a first one has not. One pass, run below: it reads only
-- generations, writes only the new table, and takes no storage lock (the
-- policy swap is the file's last statement), so a long scan blocks nobody's
-- writes; a run's asset entries are a handful of small JSON objects. The
-- pgTAP suite calls it again on seeded rows to prove its classification.
create or replace function public.backfill_seedance_prepared_assets()
returns bigint
language sql
security definer
set search_path = ''
as $$
  with recorded as (
  insert into public.seedance_prepared_assets (asset_id, owner_user_id, source, recipe_file, recorded_from, created_at)
  select distinct on (entry.asset_id)
    entry.asset_id,
    run.user_id,
    entry.source,
    coalesce(
      public.recipe_file_of_source(run.user_id, entry.source),
      (
        select public.held_input_recipe_file(kept.user_id, kept.metadata)
        from public.generation_input_media kept
        where entry.kept_input is not null
          and kept.user_id = run.user_id
          and kept.generation_id = (entry.kept_input[2])::uuid
          and kept.storage_path = 'generation_inputs/' || entry.kept_input[1] || '/' || entry.kept_input[2] || '/' || entry.kept_input[3]
        limit 1
      )
    ),
    'run',
    run.created_at
  from public.generations run
  cross join lateral (
    select
      btrim(asset ->> 'assetId') as asset_id,
      btrim(asset ->> 'sourceUrl') as source,
      regexp_match(
        btrim(asset ->> 'sourceUrl'),
        '^(?:https?://[^/?#]+/storage/v1/object/(?:sign|public|authenticated)/)?generation_inputs/([^/?#]+)/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/([^/?#]+)(?:[?#].*)?$'
      ) as kept_input
    from jsonb_array_elements(
      (case when jsonb_typeof(run.workflow_settings -> 'seedanceAssets' -> 'images') = 'array'
        then run.workflow_settings -> 'seedanceAssets' -> 'images' else '[]'::jsonb end)
      || (case when jsonb_typeof(run.workflow_settings -> 'seedanceAssets' -> 'videos') = 'array'
        then run.workflow_settings -> 'seedanceAssets' -> 'videos' else '[]'::jsonb end)
      || (case when jsonb_typeof(run.workflow_settings -> 'seedanceAssets' -> 'audios') = 'array'
        then run.workflow_settings -> 'seedanceAssets' -> 'audios' else '[]'::jsonb end)
    ) as asset
    where jsonb_typeof(asset) = 'object'
  ) entry
  where run.user_id is not null
    and jsonb_typeof(run.workflow_settings -> 'seedanceAssets') = 'object'
    and entry.asset_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$'
    and coalesce(entry.source, '') <> ''
    and exists (select 1 from auth.users owner where owner.id = run.user_id)
  order by entry.asset_id, run.created_at, run.id
  on conflict (asset_id) do nothing
    returning 1
  )
  select count(*) from recorded;
$$;

-- Callable by no API role, the server included: run again after this release it would record later
-- runs' client-written sources as 'run' rows that anyone may use. Only its owner (this migration, and
-- the pgTAP suite) runs it.
revoke all on function public.backfill_seedance_prepared_assets() from public, anon, authenticated, service_role;

select public.backfill_seedance_prepared_assets();

-- ─── The generation_inputs read policy, swapped last ────────────────────────

-- Replacing a policy on storage.objects takes an ACCESS EXCLUSIVE lock on it,
-- held until this file commits: last, so the backfill above runs without it,
-- and bounded, so a busy table fails the release rather than queueing every
-- storage call behind it.
set local lock_timeout = '5s';

drop policy if exists "Users can read own generation inputs" on storage.objects;
create policy "Users can read own generation inputs"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'generation_inputs'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.generation_input_object_readable(name)
  );
