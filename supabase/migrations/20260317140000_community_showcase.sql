-- 1. Add columns to profiles for basic creator identity
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS avatar_url text;

-- 2. Add showcase metadata columns to generations
ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS is_public boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS prompt text,
  ADD COLUMN IF NOT EXISTS category text CHECK (category IN ('image', 'video', 'motion', 'ugc-ad')),
  ADD COLUMN IF NOT EXISTS workflow_settings jsonb,
  ADD COLUMN IF NOT EXISTS save_count int DEFAULT 0,
  ADD COLUMN IF NOT EXISTS remix_count int DEFAULT 0;

-- 3. RLS policy for public generations
CREATE POLICY "Anyone can view public generations"
  ON public.generations FOR SELECT
  USING (is_public = true);

-- 4. Create showcase_saves table (Bookmarks)
CREATE TABLE IF NOT EXISTS public.showcase_saves (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users NOT NULL,
  generation_id uuid REFERENCES public.generations(id) ON DELETE CASCADE NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE(user_id, generation_id)
);

-- Enable RLS on showcase_saves
ALTER TABLE public.showcase_saves ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view saves"
  ON public.showcase_saves FOR SELECT
  USING (true);

CREATE POLICY "Users can insert their own saves"
  ON public.showcase_saves FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own saves"
  ON public.showcase_saves FOR DELETE
  USING (auth.uid() = user_id);

-- 5. Helper function to toggle save (handles increment/decrement)
CREATE OR REPLACE FUNCTION toggle_showcase_save(p_generation_id uuid, p_user_id uuid)
RETURNS boolean AS $$
DECLARE
  v_exists boolean;
BEGIN
  -- Check if save exists
  SELECT EXISTS (
    SELECT 1 FROM public.showcase_saves
    WHERE generation_id = p_generation_id AND user_id = p_user_id
  ) INTO v_exists;

  IF v_exists THEN
    -- Delete save and decrement count
    DELETE FROM public.showcase_saves
    WHERE generation_id = p_generation_id AND user_id = p_user_id;

    UPDATE public.generations
    SET save_count = GREATEST(0, save_count - 1)
    WHERE id = p_generation_id;

    RETURN false; -- Unsaved
  ELSE
    -- Insert save and increment count
    INSERT INTO public.showcase_saves (generation_id, user_id)
    VALUES (p_generation_id, p_user_id);

    UPDATE public.generations
    SET save_count = save_count + 1
    WHERE id = p_generation_id;

    RETURN true; -- Saved
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. Helper function to increment remix count
CREATE OR REPLACE FUNCTION increment_remix_count(p_generation_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE public.generations
  SET remix_count = remix_count + 1
  WHERE id = p_generation_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7. Backfill categories that may have been misclassified by the initial publish flow.
UPDATE public.generations
SET category = 'video'
WHERE model = 'kling-3.0/video'
  AND category IS DISTINCT FROM 'video';

UPDATE public.generations
SET category = 'motion'
WHERE model IN ('kling-2.6', 'kling-3.0')
  AND category IS DISTINCT FROM 'motion';
