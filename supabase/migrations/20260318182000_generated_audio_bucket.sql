insert into storage.buckets (id, name, public)
values ('generated_audio', 'generated_audio', false)
on conflict (id) do update set public = false;

drop policy if exists "Users can read own generated audio" on storage.objects;
drop policy if exists "Authenticated users can upload own generated audio" on storage.objects;

create policy "Users can read own generated audio"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'generated_audio'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Authenticated users can upload own generated audio"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'generated_audio'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
