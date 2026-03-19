ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS bio text;

UPDATE public.profiles
SET username = lower(trim(username))
WHERE username IS NOT NULL
  AND username <> lower(trim(username));

UPDATE public.profiles
SET username = lower('creator-' || left(replace(id::text, '-', ''), 8))
WHERE username IS NULL
   OR trim(username) = '';

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_username_format_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_username_format_check
  CHECK (username IS NULL OR username ~ '^[a-z0-9-]{3,24}$');

CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_unique_idx
  ON public.profiles (lower(username))
  WHERE username IS NOT NULL;

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS source_generation_id uuid
  REFERENCES public.generations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS profiles_username_lookup_idx
  ON public.profiles (username)
  WHERE username IS NOT NULL;

CREATE INDEX IF NOT EXISTS generations_user_public_created_idx
  ON public.generations (user_id, is_public, created_at DESC);

CREATE INDEX IF NOT EXISTS generations_source_generation_id_idx
  ON public.generations (source_generation_id)
  WHERE source_generation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, credits, username)
  values (
    new.id,
    25,
    lower('creator-' || left(replace(new.id::text, '-', ''), 8))
  );
  return new;
end;
$$ language plpgsql security definer;
