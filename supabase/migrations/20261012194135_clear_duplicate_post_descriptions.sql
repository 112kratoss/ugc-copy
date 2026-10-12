-- Clear post descriptions that only repeat the post's body.
--
-- The app's composer sent its Story field as both the post's description and
-- its body (ugc-mobile/lib/post-new-view-model.ts), so every app post with a
-- caption stored the text twice. The web post page prints the description as
-- a lede above the media and the body below it, so those posts read twice on
-- the page shared links open, and the web editor showed the text in both its
-- Caption and Explore description fields. The app now sends a description
-- only when the creator wrote one; this clears the rows it left behind.
--
-- Nothing is lost: the body keeps the same text, and every reader of a post's
-- description falls back to the body when it is empty -- the page's meta and
-- share description (getPublicPostMetaDescription), the embedding text
-- (supabase/functions/embed-post), the owner views and both editors. A
-- visibility flip on /api/showcase/publish carries the stored post's empty
-- description forward rather than refilling it from the generation.
--
-- Line ends are compared folded: the create and edit routes fold the body's
-- CRLF to LF and store the description as sent.
--
-- A post whose owner has an account deletion job is left alone. The content
-- freeze (reject_post_write_during_account_deletion) refuses any direct write
-- to it, which would fail this whole migration, and the deletion removes the
-- post anyway.
--
-- Each cleared row's updated_at moves, so the embedding job re-embeds it
-- without the repeated text; on an NSFW post the change also ends an open
-- reveal (advance_nsfw_revision), which lasts ten minutes at most.

UPDATE public.posts
SET description = NULL,
    updated_at = timezone('utc'::text, now())
WHERE description IS NOT NULL
  AND body IS NOT NULL
  AND btrim(replace(description, E'\r\n', E'\n')) = btrim(replace(body, E'\r\n', E'\n'))
  AND NOT public.is_account_deletion_requested(user_id);
