insert into storage.buckets (id, name, public)
values ('generated_images', 'generated_images', true)
on conflict (id) do nothing;

  create policy "Authenticated users can upload generated images"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
with check ((bucket_id = 'generated_images'::text));



  create policy "Public read access for generated images"
  on "storage"."objects"
  as permissive
  for select
  to public
using ((bucket_id = 'generated_images'::text));



