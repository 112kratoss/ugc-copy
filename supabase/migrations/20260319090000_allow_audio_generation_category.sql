ALTER TABLE public.generations
  DROP CONSTRAINT IF EXISTS generations_category_check;

ALTER TABLE public.generations
  ADD CONSTRAINT generations_category_check
  CHECK (category IN ('image', 'video', 'motion', 'ugc-ad', 'audio'));
