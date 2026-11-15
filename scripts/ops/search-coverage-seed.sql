-- Synthetic content for `npm run ops:search-coverage` and for timing the
-- search functions: 1,200 creators and 5,000 public posts with titles,
-- captions, Made with rows, covers, saves and comments.
--
-- For a throwaway replay stack only (docs/production-deployment-runbook.md,
-- "Typeahead coverage"). It refuses a database that holds a post, and it must
-- never be run on one that holds real data: it inserts accounts.
--
-- Nothing here is random between runs (setseed), so two replays hold the same
-- rows and the coverage numbers of two builds can be compared.
--
-- What it is shaped to show:
--   - styles, subjects and details people type ("cinematic portrait");
--   - the product's own models and outside tools under their catalog slugs;
--   - a known tool (Krea) and one of the product's models (Seedance 2) that
--     ONE creator alone posts with: the case the owner reported;
--   - a made-up tool (Pixel Forge) that one creator alone names, which must
--     stay out, and a made-up one many creators name (Dreamloom), which is in.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.posts) THEN
    RAISE EXCEPTION 'search-coverage-seed.sql is for an empty replay stack: this database already holds posts.';
  END IF;
END;
$$;

SELECT setseed(0.42);

CREATE TEMP TABLE seed_words(kind text, word text, place int) ON COMMIT DROP;
INSERT INTO seed_words
SELECT 'style', w, row_number() OVER () FROM unnest(ARRAY[
  'cinematic','neon','vintage','minimal','surreal','gothic','pastel','dramatic','dreamy','retro',
  'futuristic','moody','vibrant','soft','gritty','ethereal','noir','cyberpunk','fantasy','anime',
  'watercolor','isometric','abstract','rustic','glossy','matte','golden','silver','crimson','emerald']) w;
INSERT INTO seed_words
SELECT 'subject', w, row_number() OVER () FROM unnest(ARRAY[
  'portrait','landscape','city','forest','dragon','robot','castle','ocean','mountain','street',
  'garden','spaceship','warrior','queen','samurai','astronaut','cat','wolf','tiger','phoenix',
  'temple','bridge','market','library','desert','island','cathedral','village','harbor','meadow',
  'lighthouse','waterfall','skyline','alley','rooftop','cabin','throne','mask','lantern','mirror']) w;
INSERT INTO seed_words
SELECT 'detail', w, row_number() OVER () FROM unnest(ARRAY[
  'lighting','photography','illustration','render','painting','sketch','poster','wallpaper','concept','study',
  'closeup','composition','texture','shadows','reflections','details','atmosphere','colors','perspective','focus',
  'bokeh','grain','glow','haze','mist','rain','snow','sunset','sunrise','twilight']) w;
INSERT INTO seed_words
SELECT 'filler', w, row_number() OVER () FROM unnest(ARRAY[
  'of','the','a','in','with','and','on','at','by','for','under','over','near','through','from']) w;
INSERT INTO seed_words
SELECT 'first', w, row_number() OVER () FROM unnest(ARRAY[
  'Maya','Luna','Aria','Noah','Kai','Zoe','Leo','Mila','Ravi','Sana',
  'Theo','Ines','Omar','Yuki','Nora','Emil','Tara','Hugo','Lena','Arjun',
  'Mina','Felix','Rosa','Dev','Anya','Jonas','Priya','Sami','Elle','Marco']) w;
INSERT INTO seed_words
SELECT 'last', w, row_number() OVER () FROM unnest(ARRAY[
  'Okafor','Park','Varga','Lindqvist','Moreno','Tanaka','Haddad','Novak','Iyer','Castillo',
  'Brandt','Osei','Kowalski','Silva','Nakamura','Fischer','Rao','Dubois','Petrov','Alvarez',
  'Studio','Labs','Pictures','Frames','Works','Atelier','Collective','Visuals','Motion','Prints']) w;

-- Made with: the tool as a post prints it, its catalog slug, and a model for
-- some. The first places are drawn most often.
CREATE TEMP TABLE seed_tools(place int, tool text, slug text, model text, model_slug text, one_creator int) ON COMMIT DROP;
INSERT INTO seed_tools VALUES
  (1, 'Magicbooklet', 'magicbooklet', 'Nano Banana Pro', 'nano-banana-pro', NULL),
  (2, 'Midjourney', 'midjourney', 'V7', 'v7', NULL),
  (3, 'Magicbooklet', 'magicbooklet', 'Kling 2.6', 'kling-2.6', NULL),
  (4, 'Runway', 'runway', 'Gen-4.5', 'gen-4.5', NULL),
  (5, 'Magicbooklet', 'magicbooklet', 'Veo 3.1', 'veo-3.1', NULL),
  (6, 'Black Forest Labs', 'black-forest-labs', 'FLUX.2 Pro', 'flux.2-pro', NULL),
  (7, 'Magicbooklet', 'magicbooklet', 'GPT Image 2', 'gpt-image-2', NULL),
  (8, 'Leonardo.Ai', 'leonardo-ai', NULL, NULL, NULL),
  (9, 'Dreamloom', 'dreamloom', 'Loom XL', 'loom-xl', NULL),
  (10, 'Ideogram', 'ideogram', NULL, NULL, NULL),
  (11, 'Stability AI', 'stability-ai', 'Stable Diffusion 3.5 Large', 'stable-diffusion-3.5-large', NULL),
  (12, 'Luma Dream Machine', 'luma-dream-machine', NULL, NULL, NULL),
  (13, 'Kling AI', 'kling', NULL, NULL, NULL),
  (14, 'Adobe Firefly', 'adobe-firefly', 'Firefly Image 5', 'firefly-image-5', NULL),
  (15, 'Pika', 'pika', NULL, NULL, NULL),
  -- One creator alone posts with each of these three.
  (16, 'Magicbooklet', 'magicbooklet', 'Seedance 2', 'seedance-2', 7),
  (17, 'Krea', 'krea', NULL, NULL, 8),
  (18, 'Pixel Forge', 'pixel-forge', 'Forge One', 'forge-one', 9);

CREATE FUNCTION pg_temp.pick(p_kind text, p_n double precision) RETURNS text LANGUAGE sql AS $$
  SELECT word FROM seed_words WHERE kind = p_kind
  ORDER BY place OFFSET floor(p_n * (SELECT count(*) FROM seed_words WHERE kind = p_kind))::int LIMIT 1;
$$;

CREATE FUNCTION pg_temp.sid(p_prefix text, p_n int) RETURNS uuid LANGUAGE sql AS $$
  SELECT (p_prefix || '-0000-4000-9000-' || lpad(p_n::text, 12, '0'))::uuid;
$$;

INSERT INTO auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, is_anonymous)
SELECT pg_temp.sid('5eed0001', n), 'seed-' || n || '@example.invalid', 'authenticated', 'authenticated',
       '{}'::jsonb, '{}'::jsonb, now() - interval '200 days', false
FROM generate_series(1, 1200) n;

UPDATE public.profiles p
SET username = lower(named.first_name || named.last_name) || n,
    display_name = named.first_name || ' ' || named.last_name
FROM (
  SELECT n, pg_temp.pick('first', random()) AS first_name, pg_temp.pick('last', random()) AS last_name
  FROM generate_series(1, 1200) n
) AS named
WHERE p.id = pg_temp.sid('5eed0001', named.n);

-- Posts: creators by a skewed draw, ages over 120 days, 3% labelled.
CREATE TEMP TABLE seed_posts ON COMMIT DROP AS
SELECT
  drawn.n,
  pg_temp.sid('5eed0002', drawn.n) AS id,
  pg_temp.sid('5eed0001', coalesce(tools.one_creator, drawn.creator)) AS user_id,
  drawn.created_at, drawn.is_nsfw, drawn.tool_place,
  drawn.r1, drawn.r2, drawn.r3, drawn.r4, drawn.r5, drawn.r6, drawn.r7, drawn.r8
FROM (
  SELECT
    n,
    1 + floor(power(random(), 2.2) * 1200)::int AS creator,
    now() - power(random(), 1.6) * 120 * interval '1 day' AS created_at,
    random() < 0.03 AS is_nsfw,
    1 + floor(power(random(), 1.5) * 18)::int AS tool_place,
    random() AS r1, random() AS r2, random() AS r3, random() AS r4, random() AS r5, random() AS r6, random() AS r7, random() AS r8
  FROM generate_series(1, 5000) n
) AS drawn
JOIN seed_tools AS tools ON tools.place = drawn.tool_place;

CREATE FUNCTION pg_temp.insert_posts(p_from int, p_to int) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.posts (
    id, user_id, visibility, category, source_kind, post_format, review_status, is_nsfw,
    title, body, prompt, showcase_asset_path, source_tool, source_tool_slug, save_count, comment_count, created_at, updated_at
  )
  SELECT
    sp.id, sp.user_id, 'public', CASE WHEN sp.r8 < 0.25 THEN 'video' ELSE 'image' END, 'external', 'media', 'visible', sp.is_nsfw,
    initcap(pg_temp.pick('style', power(sp.r1, 1.8))) || ' ' || pg_temp.pick('subject', power(sp.r2, 1.8))
      || CASE WHEN sp.r3 < 0.5 THEN ' ' || pg_temp.pick('detail', power(sp.r3 * 2, 1.5)) ELSE '' END,
    'A ' || pg_temp.pick('style', power(sp.r4, 1.8)) || ' ' || pg_temp.pick('subject', power(sp.r2, 1.8)) || ' '
      || pg_temp.pick('filler', sp.r5) || ' ' || pg_temp.pick('style', power(sp.r6, 1.8)) || ' ' || pg_temp.pick('detail', power(sp.r7, 1.5))
      || '. Made on a quiet ' || pg_temp.pick('subject', sp.r5) || ' evening.',
    (
      SELECT string_agg(
        pg_temp.pick('style', power(abs(sin(sp.n * 7.1 + g * 1.3)), 1.8)) || ' '
          || pg_temp.pick(CASE WHEN g % 2 = 0 THEN 'subject' ELSE 'detail' END, power(abs(cos(sp.n * 3.7 + g * 2.9)), 1.6)),
        ', ' ORDER BY g)
      FROM generate_series(1, 25) g
    ),
    -- A labelled post's media is private (assert_nsfw_private_media, checked at commit).
    CASE WHEN sp.is_nsfw THEN 'private-posts/' || sp.id || '/seed.png' ELSE 'showcase/seed-' || sp.n || '.png' END,
    t.tool, t.slug,
    floor(power(sp.r6, 4) * 60)::int, floor(power(sp.r7, 5) * 20)::int,
    sp.created_at, sp.created_at
  FROM seed_posts sp
  JOIN seed_tools t ON t.place = sp.tool_place
  WHERE sp.n BETWEEN p_from AND p_to;
$$;

-- On a database just replayed the tables are empty, and the plans of the
-- per-row triggers, made at the first row, are kept for the statement: 5,000
-- rows on plans made for empty tables did not finish in ten minutes. A first
-- batch, then ANALYZE (which drops those plans), then the rest.
SELECT pg_temp.insert_posts(1, 200);
ANALYZE public.posts;
ANALYZE public.post_search_documents;
ANALYZE public.post_search_entities;
ANALYZE public.creator_search_documents;
ANALYZE public.profiles;
ANALYZE public.post_source_tools;
ANALYZE public.generations;
SELECT pg_temp.insert_posts(201, 5000);

-- Made with: the model, for two posts in three of a tool that has one.
INSERT INTO public.post_source_tools (post_id, sort_order, tool_label, tool_slug, model_label, model_slug)
SELECT sp.id, 0, t.tool, t.slug, t.model, t.model_slug
FROM seed_posts sp
JOIN seed_tools t ON t.place = sp.tool_place
WHERE t.model IS NOT NULL AND (sp.r1 < 0.66 OR t.one_creator IS NOT NULL);

-- A cover with a ready preview for nine posts in ten.
INSERT INTO public.post_media (post_id, storage_path, media_kind, content_type, width, height, sort_order,
  preview_storage_path, preview_thumbhash, preview_status)
SELECT sp.id, 'seed/' || sp.n || '/source.png', CASE WHEN sp.r8 < 0.25 THEN 'video' ELSE 'image' END,
       CASE WHEN sp.r8 < 0.25 THEN 'video/mp4' ELSE 'image/png' END, 1024, 1024 + floor(sp.r3 * 512)::int, 0,
       'seed/' || sp.n || '/preview.webp', 'thumbhash' || sp.n, 'ready'
FROM seed_posts sp
WHERE sp.r4 < 0.9 AND NOT sp.is_nsfw;

-- Saves and comments over the last 40 days.
INSERT INTO public.post_saves (user_id, post_id, created_at)
SELECT DISTINCT ON (u, p) pg_temp.sid('5eed0001', u), pg_temp.sid('5eed0002', p), now() - random() * 40 * interval '1 day'
FROM (
  SELECT 1 + floor(random() * 1200)::int AS u, 1 + floor(power(random(), 2.5) * 5000)::int AS p
  FROM generate_series(1, 12000)
) picks;

INSERT INTO public.post_comments (post_id, user_id, body, created_at)
SELECT pg_temp.sid('5eed0002', 1 + floor(power(random(), 2.5) * 5000)::int), pg_temp.sid('5eed0001', 1 + floor(random() * 1200)::int),
       'Nice work', now() - random() * 40 * interval '1 day'
FROM generate_series(1, 4000);

-- A viewer with blocks and follows: account 1200.
INSERT INTO public.user_blocks (blocker_user_id, blocked_user_id)
SELECT pg_temp.sid('5eed0001', 1200), pg_temp.sid('5eed0001', n) FROM generate_series(1, 8) n;
INSERT INTO public.follows (follower_id, following_id)
SELECT pg_temp.sid('5eed0001', 1200), pg_temp.sid('5eed0001', n) FROM generate_series(20, 40) n;

ANALYZE public.posts;
ANALYZE public.post_search_documents;
ANALYZE public.post_search_entities;
ANALYZE public.post_media;
ANALYZE public.post_saves;
ANALYZE public.post_comments;
ANALYZE public.creator_search_documents;
ANALYZE public.profiles;

-- What the ten-minute job would have made by now: the dictionary, and on a
-- build that has them the phrases and the week's counts.
SELECT * FROM public.rebuild_search_terms();
DO $$
BEGIN
  IF to_regprocedure('public.rebuild_search_phrases()') IS NOT NULL THEN
    PERFORM public.rebuild_search_phrases();
    ANALYZE public.search_phrases;
    ANALYZE public.search_popularity;
  END IF;
END;
$$;
ANALYZE public.search_terms;

COMMIT;
