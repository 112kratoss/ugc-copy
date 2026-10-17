-- Product decision 12 (2026-10-17): a post is public or private.
--
-- Unlisted is dropped. Installed apps and older web pages can still ask for
-- it, and the API stores and answers private for them before it writes (the
-- publish, create and update services). This trigger holds every other writer
-- to the same rule, so no row is stored unlisted again: a requested unlisted
-- becomes private, the safe reading of "only people with the link".
--
-- What stays: the CHECK still allows 'unlisted' and every read still handles
-- it, so nothing that reads an old value breaks. A marketplace asset's own
-- `unlisted` status is a different thing and is not touched here.
--
-- Order. BEFORE triggers fire in name order, and the AFTER triggers (the
-- generation exposure sync, the recipe exposure sync, the listing and search
-- refreshes) all read the row this one has already relabelled. The `a_`
-- prefix puts it ahead of every other BEFORE trigger on posts, the NSFW
-- revision trigger included: that one compares the visibility it is given
-- with the stored one, and a private post asked to go unlisted is no change.

CREATE OR REPLACE FUNCTION public.store_unlisted_post_as_private()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.visibility = 'unlisted' THEN
    NEW.visibility := 'private';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.store_unlisted_post_as_private()
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.store_unlisted_post_as_private() IS
  'Posts trigger: a requested unlisted visibility is stored as private (product decision 12, 2026-10-17).';

DROP TRIGGER IF EXISTS a_posts_store_unlisted_as_private ON public.posts;
CREATE TRIGGER a_posts_store_unlisted_as_private
BEFORE INSERT OR UPDATE OF visibility ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.store_unlisted_post_as_private();

-- Any post still stored unlisted (production held none on 2026-10-17). This
-- changes the label only, through the triggers above, so its generation and
-- recipe lose their exposure the way any post made private does.
UPDATE public.posts
SET visibility = 'private'
WHERE visibility = 'unlisted';
