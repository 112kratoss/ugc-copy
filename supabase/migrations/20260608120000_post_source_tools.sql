-- Create post_source_tools table for multi-tool Made With metadata
CREATE TABLE IF NOT EXISTS public.post_source_tools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  tool_label text NOT NULL,
  tool_slug text,
  model_label text,
  model_slug text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS post_source_tools_post_id_idx
  ON public.post_source_tools (post_id, sort_order);

ALTER TABLE public.post_source_tools ENABLE ROW LEVEL SECURITY;

-- Backfill existing posts into post_source_tools from legacy columns
INSERT INTO public.post_source_tools (post_id, tool_label, tool_slug, sort_order)
SELECT id, source_tool, source_tool_slug, 0
FROM public.posts
WHERE source_tool IS NOT NULL
  AND source_tool != ''
  AND NOT EXISTS (
    SELECT 1 FROM public.post_source_tools pst WHERE pst.post_id = public.posts.id
  );
