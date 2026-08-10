begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(7);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values ('0000f5c0-0000-4000-9000-000000000001'::uuid, 'f5c-search@example.invalid',
        'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);

update public.profiles
set username = 'indexed-seller', display_name = 'Indexed Seller'
where id = '0000f5c0-0000-4000-9000-000000000001'::uuid;

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status,
  title, body, showcase_asset_path, source_tool, source_tool_slug, created_at, updated_at
) values (
  '0000f5c0-0000-4000-9000-000000000010'::uuid,
  '0000f5c0-0000-4000-9000-000000000001'::uuid,
  'public', 'image', 'magicbooklet', 'media', 'visible',
  'Celestial catalog post', 'Searchable post body', 'showcase/f5c-search.png',
  'Nano Banana', 'nano-banana', now(), now()
);

insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  prompt_text, attachments, allow_remix, resource_items, resource_sections,
  price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at
) values (
  '0000f5c0-0000-4000-9000-000000000020'::uuid,
  '0000f5c0-0000-4000-9000-000000000010'::uuid,
  '0000f5c0-0000-4000-9000-000000000001'::uuid,
  'free', 'published', 'Aurora recipe bundle', 'A complete searchable summary',
  'A sufficiently descriptive preview for the quality gate.', 'A prompt',
  '[]'::jsonb, false,
  jsonb_build_array(jsonb_build_object('type', 'prompt', 'title', 'Nebula lighting')),
  '[]'::jsonb, 0, 0, 0, now(), now()
);

select is(
  (select count(*)::bigint from public.marketplace_bundle_search_documents
   where bundle_id = '0000f5c0-0000-4000-9000-000000000020'::uuid),
  1::bigint,
  'bundle insertion creates one derived search document'
);

select ok(
  (select search_text like '%nebula lighting%'
   from public.marketplace_bundle_search_documents
   where bundle_id = '0000f5c0-0000-4000-9000-000000000020'::uuid),
  'resource item text is included in the derived search document'
);

select is(
  (select count(*)::bigint
   from public.list_marketplace_resource_bundles('all', 'all', null, 'nebula', 'recent', 0, 24)
   where id = '0000f5c0-0000-4000-9000-000000000020'::uuid),
  1::bigint,
  'indexed search returns a matching listable bundle'
);

select is(
  (select count(*)::bigint
   from public.list_marketplace_resource_bundles('all', 'all', null, 'ne', 'recent', 0, 24)
   where id = '0000f5c0-0000-4000-9000-000000000020'::uuid),
  0::bigint,
  'database refuses undersized search terms even if a caller bypasses the API policy'
);

update public.posts
set body = 'Quasar replacement body'
where id = '0000f5c0-0000-4000-9000-000000000010'::uuid;

select ok(
  (select search_text like '%quasar replacement body%'
   from public.marketplace_bundle_search_documents
   where bundle_id = '0000f5c0-0000-4000-9000-000000000020'::uuid),
  'post edits refresh the derived search document'
);

update public.profiles
set display_name = 'Photon Merchant'
where id = '0000f5c0-0000-4000-9000-000000000001'::uuid;

select ok(
  (select search_text like '%photon merchant%'
   from public.marketplace_bundle_search_documents
   where bundle_id = '0000f5c0-0000-4000-9000-000000000020'::uuid),
  'profile edits refresh the derived search document'
);

select has_index(
  'public', 'marketplace_bundle_search_documents',
  'marketplace_bundle_search_documents_text_idx',
  'search documents have a trigram GIN index'
);

select * from finish();
rollback;
