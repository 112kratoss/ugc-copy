alter table public.generations
  add column if not exists completed_at timestamptz;
