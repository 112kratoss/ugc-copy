-- Clear the recipe setup notes that the quick publish modal used to prefill
-- as the post's public caption.
--
-- Until 20260823 (PR #72) the modal's caption field started from the
-- recipe's generated notes, so a quick publish that did not clear the field
-- shipped "Saved generation setup / Model: … / Aspect ratio: …" as the post's
-- description. The showcase detail page hides a description that equals the
-- bundle notes, but Post Library and the mobile feed card show it as the
-- post's text. The modal no longer prefills it; this clears the rows it
-- already left behind.
--
-- The predicate is the app's `isGeneratedRecipeSetupText`: the first line,
-- trimmed and lower-cased, is exactly "saved generation setup". Nobody types
-- that as a caption, and the same text still lives in the bundle's
-- notes_markdown, so nothing the creator wrote is lost. The body column is
-- included for symmetry; a `mixed` post whose body is cleared drops back to
-- `media` so posts_public_surface_check still holds.

UPDATE public.posts
SET description = NULL,
    updated_at = timezone('utc'::text, now())
WHERE lower(btrim(split_part(replace(coalesce(description, ''), E'\r\n', E'\n'), E'\n', 1))) = 'saved generation setup';

UPDATE public.posts
SET body = NULL,
    post_format = CASE WHEN post_format = 'mixed' THEN 'media' ELSE post_format END,
    updated_at = timezone('utc'::text, now())
WHERE lower(btrim(split_part(replace(coalesce(body, ''), E'\r\n', E'\n'), E'\n', 1))) = 'saved generation setup'
  AND post_format <> 'text';
