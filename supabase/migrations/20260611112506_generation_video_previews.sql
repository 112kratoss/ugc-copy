alter table public.generations
  add column if not exists preview_url text;

comment on column public.generations.preview_url is
  'Optional persisted poster or lightweight preview URL/path for generated media; resolved like output_url.';
