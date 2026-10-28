-- The seller's alert names what was bought a recipe (recipe audit glossary,
-- 2026-10-27): "@maya bought your recipe." and "@lee got your free recipe",
-- where it said "the resources attached to your post". The words function
-- that takes a buyer's name out of such an alert after a block or an account
-- deletion (20261020053858) matched the words of that day; rows written with
-- them keep them and must still lose their name, so it now matches both.
-- Nothing stored changes; the triggers that call it are as they were.

CREATE OR REPLACE FUNCTION public.unnamed_sale_alert_words(
  p_title text,
  p_body text,
  OUT title text,
  OUT body text
)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  title := p_title;
  body := p_body;
  -- The words written before 2026-10-27.
  IF p_title ~ '^@\S+ opened your free resources$' THEN
    title := 'Someone opened your free resources';
    body := 'A creator opened the resources attached to your post.';
  ELSIF p_body ~ '^@\S+ bought the resources attached to your post\.$' THEN
    body := 'A creator bought the resources attached to your post.';
  -- The words written since (sellerUnlockWords in src/lib/mobile-notifications.ts).
  ELSIF p_title ~ '^@\S+ got your free recipe$' THEN
    title := 'Someone got your free recipe';
    body := 'A creator got the free recipe on your post.';
  ELSIF p_body ~ '^@\S+ bought your recipe\.$' THEN
    body := 'A creator bought your recipe.';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.unnamed_sale_alert_words(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unnamed_sale_alert_words(text, text) TO service_role;

COMMENT ON FUNCTION public.unnamed_sale_alert_words(text, text) IS
  'The words a recipe sale or free-open alert has with no buyer to name, in the words written since 2026-10-27 and in those written before; words that name no one come back unchanged.';
