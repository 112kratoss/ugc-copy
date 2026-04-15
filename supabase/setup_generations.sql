-- 1. Create generations table if it doesn't exist
create table if not exists public.generations (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  model text not null,
  duration int,
  cost int,
  prediction_id text,
  status text,
  output_url text,
  completed_at timestamp with time zone,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 2. Enable RLS
alter table public.generations enable row level security;

-- 3. Create RLS policies
create policy "Users can view their own generations." on public.generations
  for select using (auth.uid() = user_id);

create policy "Users can insert their own generations." on public.generations
  for insert with check (auth.uid() = user_id);
  
create policy "Users can update their own generations." on public.generations
  for update using (auth.uid() = user_id);

-- 4. Create 'generated_videos' bucket if it doesn't exist
insert into storage.buckets (id, name, public)
values ('generated_videos', 'generated_videos', true)
on conflict (id) do nothing;

-- 5. Storage Policies for 'generated_videos'
create policy "Anyone can view generated videos." on storage.objects
  for select using ( bucket_id = 'generated_videos' );

-- Authenticated users can upload (for now, backend does it, but row level security on storage applies to client mainly. 
-- Since we use Service Role key or backend authenticated client in API, we might not strictly need this if only backend writes,
-- BUT if we use the same client as user context in API, we need insert policy).
create policy "Users can upload generated videos." on storage.objects
  for insert with check ( bucket_id = 'generated_videos' and auth.role() = 'authenticated' );
