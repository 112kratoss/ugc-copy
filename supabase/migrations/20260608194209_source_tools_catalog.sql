CREATE TABLE IF NOT EXISTS public.source_tools (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  label text NOT NULL,
  supported_media_kinds text[] NOT NULL DEFAULT ARRAY['image', 'video']::text[],
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_tools_slug_not_blank CHECK (btrim(slug) <> ''),
  CONSTRAINT source_tools_label_not_blank CHECK (btrim(label) <> ''),
  CONSTRAINT source_tools_supported_media_kinds_valid CHECK (
    supported_media_kinds <@ ARRAY['image', 'video']::text[]
    AND array_length(supported_media_kinds, 1) IS NOT NULL
  )
);

CREATE TABLE IF NOT EXISTS public.source_tool_models (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  source_tool_id uuid NOT NULL REFERENCES public.source_tools(id) ON DELETE CASCADE,
  slug text NOT NULL,
  label text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_tool_models_slug_not_blank CHECK (btrim(slug) <> ''),
  CONSTRAINT source_tool_models_label_not_blank CHECK (btrim(label) <> ''),
  CONSTRAINT source_tool_models_source_slug_unique UNIQUE (source_tool_id, slug)
);

CREATE INDEX IF NOT EXISTS source_tools_active_sort_idx
  ON public.source_tools (is_active, sort_order, label);

CREATE INDEX IF NOT EXISTS source_tool_models_active_sort_idx
  ON public.source_tool_models (source_tool_id, is_active, sort_order, label);

ALTER TABLE public.source_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_tool_models ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'source_tools'
      AND policyname = 'source_tools are readable by everyone'
  ) THEN
    CREATE POLICY "source_tools are readable by everyone"
      ON public.source_tools
      FOR SELECT
      USING (is_active);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'source_tool_models'
      AND policyname = 'source_tool_models are readable by everyone'
  ) THEN
    CREATE POLICY "source_tool_models are readable by everyone"
      ON public.source_tool_models
      FOR SELECT
      USING (is_active);
  END IF;
END $$;

WITH tool_seed(slug, label, supported_media_kinds, sort_order) AS (
  VALUES
    ('magicbooklet', 'magicbooklet', ARRAY['image', 'video']::text[], 0),
    ('higgsfield', 'Higgsfield', ARRAY['image', 'video']::text[], 10),
    ('freepik', 'Freepik', ARRAY['image']::text[], 20),
    ('runway', 'Runway', ARRAY['image', 'video']::text[], 30),
    ('midjourney', 'Midjourney', ARRAY['image']::text[], 40),
    ('kling', 'Kling', ARRAY['image', 'video']::text[], 50),
    ('sora', 'Sora', ARRAY['video']::text[], 60),
    ('veo', 'Veo', ARRAY['video']::text[], 70),
    ('capcut', 'CapCut', ARRAY['image', 'video']::text[], 80)
)
INSERT INTO public.source_tools (slug, label, supported_media_kinds, sort_order, is_active, updated_at)
SELECT slug, label, supported_media_kinds, sort_order, true, now()
FROM tool_seed
ON CONFLICT (slug) DO UPDATE
SET
  label = EXCLUDED.label,
  supported_media_kinds = EXCLUDED.supported_media_kinds,
  sort_order = EXCLUDED.sort_order,
  is_active = true,
  updated_at = now();

WITH model_seed(tool_slug, slug, label, sort_order) AS (
  VALUES
    ('magicbooklet', 'nano-banana-2', 'Nano Banana 2.0', 0),
    ('magicbooklet', 'nano-banana-pro', 'Nano Banana Pro', 10),
    ('magicbooklet', 'gpt-image-2', 'GPT Image 2', 20),
    ('magicbooklet', 'grok-imagine-image', 'Grok Imagine', 30),
    ('magicbooklet', 'kling-2.6', 'Kling 2.6 Motion', 40),
    ('magicbooklet', 'kling-3.0', 'Kling 3.0 Motion', 50),
    ('magicbooklet', 'kling-3.0-video', 'Kling 3.0 Cinematic', 60),
    ('magicbooklet', 'seedance-1.5-pro', 'Seedance 1.5 Pro', 70),
    ('magicbooklet', 'seedance-2', 'Seedance 2', 80),
    ('magicbooklet', 'seedance-2-fast', 'Seedance 2 Fast', 90),
    ('magicbooklet', 'veo-3.1', 'Veo 3.1', 100),
    ('magicbooklet', 'grok-imagine-video', 'Grok Imagine Video', 110),
    ('higgsfield', 'soul', 'Soul', 0),
    ('higgsfield', 'k2', 'K2', 10),
    ('freepik', 'mystic', 'Mystic', 0),
    ('freepik', 'classic', 'Classic', 10),
    ('runway', 'gen-3', 'Gen-3', 0),
    ('runway', 'gen-4', 'Gen-4', 10),
    ('kling', 'kling-2.6', 'Kling 2.6', 0),
    ('kling', 'kling-3.0', 'Kling 3.0', 10),
    ('veo', 'veo-3.1', 'Veo 3.1', 0)
)
INSERT INTO public.source_tool_models (source_tool_id, slug, label, sort_order, is_active, updated_at)
SELECT source_tools.id, model_seed.slug, model_seed.label, model_seed.sort_order, true, now()
FROM model_seed
JOIN public.source_tools ON source_tools.slug = model_seed.tool_slug
ON CONFLICT (source_tool_id, slug) DO UPDATE
SET
  label = EXCLUDED.label,
  sort_order = EXCLUDED.sort_order,
  is_active = true,
  updated_at = now();
