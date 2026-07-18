ALTER TABLE public.source_tools
  ADD COLUMN IF NOT EXISTS tool_type text NOT NULL DEFAULT 'platform',
  ADD COLUMN IF NOT EXISTS capabilities text[] NOT NULL DEFAULT ARRAY['image', 'video']::text[],
  ADD COLUMN IF NOT EXISTS catalog_tier text NOT NULL DEFAULT 'extended',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'current',
  ADD COLUMN IF NOT EXISTS provider_slug text,
  ADD COLUMN IF NOT EXISTS aliases text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS catalog_source_url text,
  ADD COLUMN IF NOT EXISTS last_verified_at date;

ALTER TABLE public.source_tool_models
  ADD COLUMN IF NOT EXISTS capabilities text[] NOT NULL DEFAULT ARRAY['image', 'video']::text[],
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'current',
  ADD COLUMN IF NOT EXISTS provider_slug text,
  ADD COLUMN IF NOT EXISTS aliases text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS catalog_source_url text,
  ADD COLUMN IF NOT EXISTS last_verified_at date;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'source_tools_tool_type_valid') THEN
    ALTER TABLE public.source_tools ADD CONSTRAINT source_tools_tool_type_valid
      CHECK (tool_type IN ('platform', 'editor', 'workflow', 'api-marketplace'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'source_tools_capabilities_valid') THEN
    ALTER TABLE public.source_tools ADD CONSTRAINT source_tools_capabilities_valid
      CHECK (
        capabilities <@ ARRAY['image', 'video', 'audio', 'avatar', 'design', '3d', 'vfx']::text[]
        AND array_length(capabilities, 1) IS NOT NULL
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'source_tools_catalog_tier_valid') THEN
    ALTER TABLE public.source_tools ADD CONSTRAINT source_tools_catalog_tier_valid
      CHECK (catalog_tier IN ('featured', 'extended', 'historical'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'source_tools_status_valid') THEN
    ALTER TABLE public.source_tools ADD CONSTRAINT source_tools_status_valid
      CHECK (status IN ('current', 'legacy', 'deprecated', 'sunset'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'source_tool_models_capabilities_valid') THEN
    ALTER TABLE public.source_tool_models ADD CONSTRAINT source_tool_models_capabilities_valid
      CHECK (
        capabilities <@ ARRAY['image', 'video', 'audio', 'avatar', 'design', '3d', 'vfx']::text[]
        AND array_length(capabilities, 1) IS NOT NULL
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'source_tool_models_status_valid') THEN
    ALTER TABLE public.source_tool_models ADD CONSTRAINT source_tool_models_status_valid
      CHECK (status IN ('current', 'legacy', 'deprecated', 'sunset'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS source_tools_catalog_browse_idx
  ON public.source_tools (is_active, catalog_tier, status, sort_order, label);

COMMENT ON COLUMN public.source_tools.catalog_tier IS
  'featured tools appear in the default picker, extended tools are search-first, and historical tools remain available for attribution compatibility.';
COMMENT ON COLUMN public.source_tools.status IS
  'Lifecycle state for attribution discovery. Non-current entries remain readable so existing posts never lose their attribution.';

WITH tool_seed(
  slug, label, supported_media_kinds, sort_order, tool_type, capabilities,
  catalog_tier, status, provider_slug, aliases, catalog_source_url
) AS (
  VALUES
    ('magicbooklet', 'magicbooklet', ARRAY['image','video']::text[], 0, 'platform', ARRAY['image','video']::text[], 'featured', 'current', 'magicbooklet', ARRAY['Magic Booklet','Emptybooklet']::text[], 'https://magicbooklet.com'),
    ('adobe-firefly', 'Adobe Firefly', ARRAY['image','video']::text[], 10, 'platform', ARRAY['image','video']::text[], 'featured', 'current', 'adobe', ARRAY['Firefly']::text[], 'https://www.adobe.com/products/firefly.html'),
    ('midjourney', 'Midjourney', ARRAY['image','video']::text[], 20, 'platform', ARRAY['image','video']::text[], 'featured', 'current', 'midjourney', ARRAY[]::text[], 'https://www.midjourney.com'),
    ('runway', 'Runway', ARRAY['image','video']::text[], 30, 'platform', ARRAY['image','video','avatar','vfx']::text[], 'featured', 'current', 'runway', ARRAY['Runway ML']::text[], 'https://runwayml.com'),
    ('google-gemini-flow', 'Google Gemini / Flow', ARRAY['image','video']::text[], 40, 'platform', ARRAY['image','video']::text[], 'featured', 'current', 'google', ARRAY['Gemini','Flow','Google AI Studio','Nano Banana','Veo']::text[], 'https://labs.google/fx/tools/flow'),
    ('openai-chatgpt', 'ChatGPT', ARRAY['image']::text[], 50, 'platform', ARRAY['image']::text[], 'featured', 'current', 'openai', ARRAY['OpenAI','GPT Image']::text[], 'https://openai.com/chatgpt/overview'),
    ('kling', 'Kling AI', ARRAY['image','video']::text[], 60, 'platform', ARRAY['image','video']::text[], 'featured', 'current', 'kuaishou', ARRAY['Kling']::text[], 'https://klingai.com'),
    ('higgsfield', 'Higgsfield', ARRAY['image','video']::text[], 70, 'platform', ARRAY['image','video']::text[], 'featured', 'current', 'higgsfield', ARRAY[]::text[], 'https://higgsfield.ai'),
    ('freepik', 'Freepik', ARRAY['image','video']::text[], 80, 'platform', ARRAY['image','video','design']::text[], 'featured', 'current', 'freepik', ARRAY['Freepik AI Suite']::text[], 'https://www.freepik.com/ai'),
    ('leonardo-ai', 'Leonardo.Ai', ARRAY['image','video']::text[], 90, 'platform', ARRAY['image','video']::text[], 'featured', 'current', 'leonardo-ai', ARRAY['Leonardo']::text[], 'https://leonardo.ai'),
    ('black-forest-labs', 'Black Forest Labs', ARRAY['image']::text[], 100, 'platform', ARRAY['image']::text[], 'featured', 'current', 'black-forest-labs', ARRAY['BFL','FLUX','Flux AI']::text[], 'https://bfl.ai'),
    ('stability-ai', 'Stability AI', ARRAY['image']::text[], 110, 'platform', ARRAY['image']::text[], 'featured', 'current', 'stability-ai', ARRAY['Stable Diffusion','SDXL']::text[], 'https://stability.ai'),
    ('ideogram', 'Ideogram', ARRAY['image']::text[], 120, 'platform', ARRAY['image']::text[], 'featured', 'current', 'ideogram', ARRAY[]::text[], 'https://ideogram.ai'),
    ('recraft', 'Recraft', ARRAY['image']::text[], 130, 'platform', ARRAY['image','design']::text[], 'featured', 'current', 'recraft', ARRAY[]::text[], 'https://www.recraft.ai'),
    ('krea', 'Krea', ARRAY['image','video']::text[], 140, 'platform', ARRAY['image','video']::text[], 'featured', 'current', 'krea', ARRAY[]::text[], 'https://www.krea.ai'),
    ('luma-dream-machine', 'Luma Dream Machine', ARRAY['image','video']::text[], 150, 'platform', ARRAY['image','video']::text[], 'featured', 'current', 'luma-ai', ARRAY['Luma AI','Dream Machine']::text[], 'https://lumalabs.ai/dream-machine'),
    ('pika', 'Pika', ARRAY['image','video']::text[], 160, 'platform', ARRAY['image','video']::text[], 'featured', 'current', 'pika', ARRAY['Pika Labs']::text[], 'https://pika.art'),
    ('capcut', 'CapCut', ARRAY['image','video']::text[], 170, 'editor', ARRAY['image','video','audio','design']::text[], 'featured', 'current', 'bytedance', ARRAY[]::text[], 'https://www.capcut.com'),
    ('canva', 'Canva', ARRAY['image','video']::text[], 180, 'editor', ARRAY['image','video','design']::text[], 'featured', 'current', 'canva', ARRAY[]::text[], 'https://www.canva.com'),
    ('adobe-photoshop', 'Adobe Photoshop', ARRAY['image']::text[], 190, 'editor', ARRAY['image','design']::text[], 'featured', 'current', 'adobe', ARRAY['Photoshop']::text[], 'https://www.adobe.com/products/photoshop.html'),
    ('adobe-premiere-pro', 'Adobe Premiere Pro', ARRAY['video']::text[], 200, 'editor', ARRAY['video','audio']::text[], 'featured', 'current', 'adobe', ARRAY['Premiere Pro']::text[], 'https://www.adobe.com/products/premiere.html'),
    ('adobe-after-effects', 'Adobe After Effects', ARRAY['video']::text[], 210, 'editor', ARRAY['video','vfx']::text[], 'featured', 'current', 'adobe', ARRAY['After Effects','AE']::text[], 'https://www.adobe.com/products/aftereffects.html'),
    ('davinci-resolve', 'DaVinci Resolve', ARRAY['video']::text[], 220, 'editor', ARRAY['video','audio','vfx']::text[], 'featured', 'current', 'blackmagic-design', ARRAY['Resolve']::text[], 'https://www.blackmagicdesign.com/products/davinciresolve'),
    ('final-cut-pro', 'Final Cut Pro', ARRAY['video']::text[], 230, 'editor', ARRAY['video','audio']::text[], 'featured', 'current', 'apple', ARRAY['FCP']::text[], 'https://www.apple.com/final-cut-pro'),
    ('figma', 'Figma', ARRAY['image']::text[], 240, 'editor', ARRAY['image','design']::text[], 'featured', 'current', 'figma', ARRAY[]::text[], 'https://www.figma.com'),
    ('blender', 'Blender', ARRAY['image','video']::text[], 250, 'editor', ARRAY['image','video','3d','vfx']::text[], 'featured', 'current', 'blender', ARRAY[]::text[], 'https://www.blender.org'),
    ('comfyui', 'ComfyUI', ARRAY['image','video']::text[], 260, 'workflow', ARRAY['image','video']::text[], 'featured', 'current', 'comfy-org', ARRAY['Comfy UI']::text[], 'https://www.comfy.org'),
    ('heygen', 'HeyGen', ARRAY['video']::text[], 270, 'platform', ARRAY['video','audio','avatar']::text[], 'featured', 'current', 'heygen', ARRAY[]::text[], 'https://www.heygen.com'),
    ('elevenlabs', 'ElevenLabs', ARRAY['video']::text[], 280, 'platform', ARRAY['audio']::text[], 'featured', 'current', 'elevenlabs', ARRAY['11Labs']::text[], 'https://elevenlabs.io'),
    ('minimax-hailuo', 'MiniMax Hailuo', ARRAY['video']::text[], 1000, 'platform', ARRAY['video']::text[], 'extended', 'current', 'minimax', ARRAY['Hailuo AI']::text[], 'https://hailuoai.video'),
    ('dreamina', 'Dreamina', ARRAY['image','video']::text[], 1010, 'platform', ARRAY['image','video']::text[], 'extended', 'current', 'bytedance', ARRAY['Seedream','Seedance']::text[], 'https://dreamina.capcut.com'),
    ('wan-ai', 'Wan AI', ARRAY['image','video']::text[], 1020, 'platform', ARRAY['image','video']::text[], 'extended', 'current', 'alibaba', ARRAY['Wan Video']::text[], 'https://wan.video'),
    ('vidu', 'Vidu', ARRAY['video']::text[], 1030, 'platform', ARRAY['video']::text[], 'extended', 'current', 'shengshu', ARRAY[]::text[], 'https://www.vidu.com'),
    ('pixverse', 'PixVerse', ARRAY['video']::text[], 1040, 'platform', ARRAY['video']::text[], 'extended', 'current', 'pixverse', ARRAY[]::text[], 'https://pixverse.ai'),
    ('ltx-studio', 'LTX Studio', ARRAY['video']::text[], 1050, 'platform', ARRAY['video']::text[], 'extended', 'current', 'lightricks', ARRAY['LTX Video']::text[], 'https://ltx.studio'),
    ('xai-grok', 'Grok', ARRAY['image','video']::text[], 1060, 'platform', ARRAY['image','video']::text[], 'extended', 'current', 'xai', ARRAY['xAI','Grok Imagine']::text[], 'https://grok.com'),
    ('adobe-lightroom', 'Adobe Lightroom', ARRAY['image']::text[], 1100, 'editor', ARRAY['image']::text[], 'extended', 'current', 'adobe', ARRAY['Lightroom']::text[], 'https://www.adobe.com/products/photoshop-lightroom.html'),
    ('adobe-illustrator', 'Adobe Illustrator', ARRAY['image']::text[], 1110, 'editor', ARRAY['image','design']::text[], 'extended', 'current', 'adobe', ARRAY['Illustrator']::text[], 'https://www.adobe.com/products/illustrator.html'),
    ('adobe-express', 'Adobe Express', ARRAY['image','video']::text[], 1120, 'editor', ARRAY['image','video','design']::text[], 'extended', 'current', 'adobe', ARRAY[]::text[], 'https://www.adobe.com/express'),
    ('adobe-audition', 'Adobe Audition', ARRAY['video']::text[], 1130, 'editor', ARRAY['audio']::text[], 'extended', 'current', 'adobe', ARRAY['Audition']::text[], 'https://www.adobe.com/products/audition.html'),
    ('cinema-4d', 'Cinema 4D', ARRAY['image','video']::text[], 1140, 'editor', ARRAY['image','video','3d','vfx']::text[], 'extended', 'current', 'maxon', ARRAY['C4D']::text[], 'https://www.maxon.net/cinema-4d'),
    ('zbrush', 'ZBrush', ARRAY['image']::text[], 1150, 'editor', ARRAY['image','3d']::text[], 'extended', 'current', 'maxon', ARRAY[]::text[], 'https://www.maxon.net/zbrush'),
    ('unreal-engine', 'Unreal Engine', ARRAY['image','video']::text[], 1160, 'editor', ARRAY['image','video','3d','vfx']::text[], 'extended', 'current', 'epic-games', ARRAY['UE5']::text[], 'https://www.unrealengine.com'),
    ('procreate', 'Procreate', ARRAY['image']::text[], 1170, 'editor', ARRAY['image','design']::text[], 'extended', 'current', 'savagem-interactive', ARRAY[]::text[], 'https://procreate.com'),
    ('procreate-dreams', 'Procreate Dreams', ARRAY['video']::text[], 1180, 'editor', ARRAY['video','design']::text[], 'extended', 'current', 'savagem-interactive', ARRAY[]::text[], 'https://procreate.com/dreams'),
    ('affinity', 'Affinity', ARRAY['image']::text[], 1190, 'editor', ARRAY['image','design']::text[], 'extended', 'current', 'canva', ARRAY['Affinity Photo','Affinity Designer']::text[], 'https://affinity.serif.com'),
    ('descript', 'Descript', ARRAY['video']::text[], 1200, 'editor', ARRAY['video','audio']::text[], 'extended', 'current', 'descript', ARRAY[]::text[], 'https://www.descript.com'),
    ('veed', 'VEED', ARRAY['video']::text[], 1210, 'editor', ARRAY['video','audio']::text[], 'extended', 'current', 'veed', ARRAY[]::text[], 'https://www.veed.io'),
    ('invideo', 'InVideo', ARRAY['video']::text[], 1220, 'editor', ARRAY['video','audio']::text[], 'extended', 'current', 'invideo', ARRAY[]::text[], 'https://invideo.io'),
    ('synthesia', 'Synthesia', ARRAY['video']::text[], 1230, 'platform', ARRAY['video','audio','avatar']::text[], 'extended', 'current', 'synthesia', ARRAY[]::text[], 'https://www.synthesia.io'),
    ('d-id', 'D-ID', ARRAY['video']::text[], 1240, 'platform', ARRAY['video','audio','avatar']::text[], 'extended', 'current', 'd-id', ARRAY[]::text[], 'https://www.d-id.com'),
    ('suno', 'Suno', ARRAY['video']::text[], 1250, 'platform', ARRAY['audio']::text[], 'extended', 'current', 'suno', ARRAY[]::text[], 'https://suno.com'),
    ('udio', 'Udio', ARRAY['video']::text[], 1260, 'platform', ARRAY['audio']::text[], 'extended', 'current', 'udio', ARRAY[]::text[], 'https://www.udio.com'),
    ('automatic1111', 'AUTOMATIC1111', ARRAY['image']::text[], 1300, 'workflow', ARRAY['image']::text[], 'extended', 'current', 'community', ARRAY['A1111','Stable Diffusion WebUI']::text[], 'https://github.com/AUTOMATIC1111/stable-diffusion-webui'),
    ('invokeai', 'InvokeAI', ARRAY['image']::text[], 1310, 'workflow', ARRAY['image']::text[], 'extended', 'current', 'invoke-ai', ARRAY[]::text[], 'https://invoke.ai'),
    ('replicate', 'Replicate', ARRAY['image','video']::text[], 1400, 'api-marketplace', ARRAY['image','video','audio']::text[], 'extended', 'current', 'replicate', ARRAY[]::text[], 'https://replicate.com'),
    ('fal', 'fal', ARRAY['image','video']::text[], 1410, 'api-marketplace', ARRAY['image','video','audio']::text[], 'extended', 'current', 'fal', ARRAY['fal.ai']::text[], 'https://fal.ai'),
    ('kie-ai', 'Kie.ai', ARRAY['image','video']::text[], 1420, 'api-marketplace', ARRAY['image','video','audio']::text[], 'extended', 'current', 'kie-ai', ARRAY['Kie AI']::text[], 'https://kie.ai'),
    ('hugging-face', 'Hugging Face', ARRAY['image','video']::text[], 1430, 'api-marketplace', ARRAY['image','video','audio']::text[], 'extended', 'current', 'hugging-face', ARRAY['HF']::text[], 'https://huggingface.co'),
    ('sora', 'Sora', ARRAY['video']::text[], 9000, 'platform', ARRAY['video']::text[], 'historical', 'sunset', 'openai', ARRAY[]::text[], 'https://openai.com/sora'),
    ('veo', 'Google Veo', ARRAY['video']::text[], 9010, 'platform', ARRAY['video']::text[], 'historical', 'legacy', 'google', ARRAY['Veo']::text[], 'https://deepmind.google/models/veo')
)
INSERT INTO public.source_tools (
  slug, label, supported_media_kinds, sort_order, is_active, tool_type, capabilities,
  catalog_tier, status, provider_slug, aliases, catalog_source_url, last_verified_at, updated_at
)
SELECT
  slug, label, supported_media_kinds, sort_order, true, tool_type, capabilities,
  catalog_tier, status, provider_slug, aliases, catalog_source_url, DATE '2026-07-18', now()
FROM tool_seed
ON CONFLICT (slug) DO UPDATE SET
  label = EXCLUDED.label,
  supported_media_kinds = EXCLUDED.supported_media_kinds,
  sort_order = EXCLUDED.sort_order,
  is_active = true,
  tool_type = EXCLUDED.tool_type,
  capabilities = EXCLUDED.capabilities,
  catalog_tier = EXCLUDED.catalog_tier,
  status = EXCLUDED.status,
  provider_slug = EXCLUDED.provider_slug,
  aliases = EXCLUDED.aliases,
  catalog_source_url = EXCLUDED.catalog_source_url,
  last_verified_at = EXCLUDED.last_verified_at,
  updated_at = now();

WITH model_seed(tool_slug, slug, label, sort_order, capabilities, status, provider_slug, aliases) AS (
  VALUES
    ('adobe-firefly','firefly-image-5','Firefly Image 5',0,ARRAY['image']::text[],'current','adobe',ARRAY[]::text[]),
    ('adobe-firefly','firefly-image-4-ultra','Firefly Image 4 Ultra',10,ARRAY['image']::text[],'current','adobe',ARRAY[]::text[]),
    ('adobe-firefly','firefly-video','Firefly Video',20,ARRAY['video']::text[],'current','adobe',ARRAY[]::text[]),
    ('midjourney','v8.1','V8.1',0,ARRAY['image']::text[],'current','midjourney',ARRAY[]::text[]),
    ('midjourney','v7','V7',10,ARRAY['image']::text[],'current','midjourney',ARRAY[]::text[]),
    ('midjourney','niji-7','Niji 7',20,ARRAY['image']::text[],'current','midjourney',ARRAY['Niji']::text[]),
    ('midjourney','midjourney-video','Midjourney Video',30,ARRAY['video']::text[],'current','midjourney',ARRAY[]::text[]),
    ('runway','gen-4.5','Gen-4.5',0,ARRAY['video']::text[],'current','runway',ARRAY[]::text[]),
    ('runway','aleph-2','Aleph 2',10,ARRAY['video','vfx']::text[],'current','runway',ARRAY[]::text[]),
    ('runway','gen-4-turbo','Gen-4 Turbo',20,ARRAY['video']::text[],'current','runway',ARRAY[]::text[]),
    ('runway','act-two','Act-Two',30,ARRAY['video','avatar']::text[],'current','runway',ARRAY['Act Two']::text[]),
    ('google-gemini-flow','nano-banana-2','Nano Banana 2',0,ARRAY['image']::text[],'current','google',ARRAY[]::text[]),
    ('google-gemini-flow','nano-banana-pro','Nano Banana Pro',10,ARRAY['image']::text[],'current','google',ARRAY[]::text[]),
    ('google-gemini-flow','veo-3.1','Veo 3.1',20,ARRAY['video']::text[],'current','google',ARRAY[]::text[]),
    ('google-gemini-flow','veo-3.1-fast','Veo 3.1 Fast',30,ARRAY['video']::text[],'current','google',ARRAY[]::text[]),
    ('openai-chatgpt','gpt-image-2','GPT Image 2',0,ARRAY['image']::text[],'current','openai',ARRAY[]::text[]),
    ('openai-chatgpt','gpt-image-1.5','GPT Image 1.5',10,ARRAY['image']::text[],'current','openai',ARRAY[]::text[]),
    ('openai-chatgpt','gpt-image-1','GPT Image 1',20,ARRAY['image']::text[],'current','openai',ARRAY[]::text[]),
    ('kling','kling-3.0','Kling 3.0',0,ARRAY['image','video']::text[],'current','kuaishou',ARRAY[]::text[]),
    ('kling','kling-o3','Kling O3',10,ARRAY['video']::text[],'current','kuaishou',ARRAY[]::text[]),
    ('kling','kling-2.6','Kling 2.6',20,ARRAY['video']::text[],'current','kuaishou',ARRAY[]::text[]),
    ('kling','motion-control','Motion Control',30,ARRAY['video']::text[],'current','kuaishou',ARRAY[]::text[]),
    ('higgsfield','soul','Soul',0,ARRAY['image']::text[],'current','higgsfield',ARRAY[]::text[]),
    ('higgsfield','k2','K2',10,ARRAY['image','video']::text[],'current','higgsfield',ARRAY[]::text[]),
    ('freepik','mystic','Mystic',0,ARRAY['image']::text[],'current','freepik',ARRAY[]::text[]),
    ('freepik','classic','Classic',10,ARRAY['image']::text[],'current','freepik',ARRAY[]::text[]),
    ('leonardo-ai','lucid-origin','Lucid Origin',0,ARRAY['image']::text[],'current','leonardo-ai',ARRAY[]::text[]),
    ('leonardo-ai','lucid-realism','Lucid Realism',10,ARRAY['image']::text[],'current','leonardo-ai',ARRAY[]::text[]),
    ('leonardo-ai','phoenix-1.0','Phoenix 1.0',20,ARRAY['image']::text[],'current','leonardo-ai',ARRAY[]::text[]),
    ('black-forest-labs','flux.2-max','FLUX.2 Max',0,ARRAY['image']::text[],'current','black-forest-labs',ARRAY['Flux 2 Max']::text[]),
    ('black-forest-labs','flux.2-pro','FLUX.2 Pro',10,ARRAY['image']::text[],'current','black-forest-labs',ARRAY['Flux 2 Pro']::text[]),
    ('black-forest-labs','flux.2-flex','FLUX.2 Flex',20,ARRAY['image']::text[],'current','black-forest-labs',ARRAY['Flux 2 Flex']::text[]),
    ('black-forest-labs','flux.1-kontext-max','FLUX.1 Kontext Max',30,ARRAY['image']::text[],'current','black-forest-labs',ARRAY['Flux Kontext']::text[]),
    ('stability-ai','stable-image-ultra','Stable Image Ultra',0,ARRAY['image']::text[],'current','stability-ai',ARRAY[]::text[]),
    ('stability-ai','stable-image-core','Stable Image Core',10,ARRAY['image']::text[],'current','stability-ai',ARRAY[]::text[]),
    ('stability-ai','stable-diffusion-3.5-large','Stable Diffusion 3.5 Large',20,ARRAY['image']::text[],'current','stability-ai',ARRAY['SD 3.5 Large']::text[]),
    ('ideogram','ideogram-3.0','Ideogram 3.0',0,ARRAY['image']::text[],'current','ideogram',ARRAY[]::text[]),
    ('ideogram','ideogram-2a','Ideogram 2a',10,ARRAY['image']::text[],'current','ideogram',ARRAY[]::text[]),
    ('recraft','recraft-v3','Recraft V3',0,ARRAY['image','design']::text[],'current','recraft',ARRAY[]::text[]),
    ('luma-dream-machine','ray-2','Ray 2',0,ARRAY['video']::text[],'current','luma-ai',ARRAY[]::text[]),
    ('luma-dream-machine','ray-2-flash','Ray 2 Flash',10,ARRAY['video']::text[],'current','luma-ai',ARRAY[]::text[]),
    ('pika','pika-2.2','Pika 2.2',0,ARRAY['video']::text[],'current','pika',ARRAY[]::text[]),
    ('pika','pika-2.1','Pika 2.1',10,ARRAY['video']::text[],'current','pika',ARRAY[]::text[]),
    ('pika','pika-turbo','Pika Turbo',20,ARRAY['video']::text[],'current','pika',ARRAY[]::text[]),
    ('heygen','avatar-iv','Avatar IV',0,ARRAY['video','avatar']::text[],'current','heygen',ARRAY[]::text[]),
    ('heygen','digital-twin','Digital Twin',10,ARRAY['video','avatar']::text[],'current','heygen',ARRAY[]::text[]),
    ('elevenlabs','eleven-v3','Eleven v3',0,ARRAY['audio']::text[],'current','elevenlabs',ARRAY[]::text[]),
    ('elevenlabs','multilingual-v2','Multilingual v2',10,ARRAY['audio']::text[],'current','elevenlabs',ARRAY[]::text[]),
    ('elevenlabs','sound-effects-v2','Sound Effects v2',20,ARRAY['audio']::text[],'current','elevenlabs',ARRAY[]::text[]),
    ('minimax-hailuo','hailuo-2.3','Hailuo 2.3',0,ARRAY['video']::text[],'current','minimax',ARRAY[]::text[]),
    ('minimax-hailuo','hailuo-2.3-fast','Hailuo 2.3 Fast',10,ARRAY['video']::text[],'current','minimax',ARRAY[]::text[]),
    ('dreamina','seedream','Seedream',0,ARRAY['image']::text[],'current','bytedance',ARRAY[]::text[]),
    ('dreamina','seedance','Seedance',10,ARRAY['video']::text[],'current','bytedance',ARRAY[]::text[]),
    ('wan-ai','wan-2.6','Wan 2.6',0,ARRAY['video']::text[],'current','alibaba',ARRAY[]::text[]),
    ('wan-ai','wan-2.5','Wan 2.5',10,ARRAY['video']::text[],'current','alibaba',ARRAY[]::text[]),
    ('vidu','q3','Q3',0,ARRAY['video']::text[],'current','shengshu',ARRAY[]::text[]),
    ('vidu','q3-turbo','Q3 Turbo',10,ARRAY['video']::text[],'current','shengshu',ARRAY[]::text[]),
    ('pixverse','v6','V6',0,ARRAY['video']::text[],'current','pixverse',ARRAY[]::text[]),
    ('ltx-studio','ltx-2.3-fast','LTX 2.3 Fast',0,ARRAY['video']::text[],'current','lightricks',ARRAY[]::text[]),
    ('ltx-studio','ltx-2.3-pro','LTX 2.3 Pro',10,ARRAY['video']::text[],'current','lightricks',ARRAY[]::text[]),
    ('xai-grok','grok-imagine-image','Grok Imagine Image',0,ARRAY['image']::text[],'current','xai',ARRAY[]::text[]),
    ('xai-grok','grok-imagine-video','Grok Imagine Video',10,ARRAY['video']::text[],'current','xai',ARRAY[]::text[]),
    ('sora','sora-2','Sora 2',0,ARRAY['video']::text[],'sunset','openai',ARRAY[]::text[]),
    ('sora','sora-2-pro','Sora 2 Pro',10,ARRAY['video']::text[],'sunset','openai',ARRAY[]::text[]),
    ('veo','veo-3.1','Veo 3.1',0,ARRAY['video']::text[],'legacy','google',ARRAY[]::text[])
)
INSERT INTO public.source_tool_models (
  source_tool_id, slug, label, sort_order, is_active, capabilities, status,
  provider_slug, aliases, catalog_source_url, last_verified_at, updated_at
)
SELECT
  source_tools.id, model_seed.slug, model_seed.label, model_seed.sort_order, true,
  model_seed.capabilities, model_seed.status, model_seed.provider_slug, model_seed.aliases,
  source_tools.catalog_source_url, DATE '2026-07-18', now()
FROM model_seed
JOIN public.source_tools ON source_tools.slug = model_seed.tool_slug
ON CONFLICT (source_tool_id, slug) DO UPDATE SET
  label = EXCLUDED.label,
  sort_order = EXCLUDED.sort_order,
  is_active = true,
  capabilities = EXCLUDED.capabilities,
  status = EXCLUDED.status,
  provider_slug = EXCLUDED.provider_slug,
  aliases = EXCLUDED.aliases,
  catalog_source_url = EXCLUDED.catalog_source_url,
  last_verified_at = EXCLUDED.last_verified_at,
  updated_at = now();
