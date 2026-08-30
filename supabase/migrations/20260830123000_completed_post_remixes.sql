-- Public remixes mean completed generations, not editor opens. Preserve the
-- old start-based metric for audit; rebuild history only from known lineage.
ALTER TABLE public.posts ADD COLUMN legacy_remix_start_count integer;
UPDATE public.posts SET legacy_remix_start_count = remix_count;

CREATE TABLE public.completed_post_remixes (
  generation_id uuid PRIMARY KEY REFERENCES public.generations(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  completed_at timestamptz NOT NULL DEFAULT now(),
  -- False only for rows the backfill invents below. Nothing flips it later:
  -- repeat delivery is stopped by the notification's own dedupe key, so this
  -- says "this remix predates the feature", not "not notified yet".
  notification_eligible boolean NOT NULL DEFAULT true
);
CREATE INDEX completed_post_remixes_post_idx ON public.completed_post_remixes(post_id);
ALTER TABLE public.completed_post_remixes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.completed_post_remixes FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.completed_post_remixes TO service_role;

INSERT INTO public.completed_post_remixes(generation_id, post_id, actor_user_id, completed_at, notification_eligible)
SELECT g.id, p.id, g.user_id, coalesce(g.completed_at, g.created_at), false
FROM public.generations g
JOIN public.generations source ON source.id = g.source_generation_id
JOIN public.posts p ON p.generation_id = source.id AND p.user_id = source.user_id
WHERE g.status = 'succeeded' AND nullif(trim(g.output_url), '') IS NOT NULL
  AND p.visibility = 'public';

UPDATE public.posts p SET remix_count = (
  SELECT count(*)::integer FROM public.completed_post_remixes r WHERE r.post_id = p.id
);

CREATE FUNCTION public.record_completed_post_remix()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_post_id uuid;
  v_inserted_id uuid;
BEGIN
  IF NEW.status <> 'succeeded' OR NEW.source_generation_id IS NULL
    OR nullif(trim(NEW.output_url), '') IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT p.id INTO v_post_id
  FROM public.posts p JOIN public.generations source ON source.id = p.generation_id
  WHERE p.generation_id = NEW.source_generation_id AND p.user_id = source.user_id
    AND p.visibility = 'public';
  IF v_post_id IS NULL THEN RETURN NEW; END IF;

  INSERT INTO public.completed_post_remixes(generation_id, post_id, actor_user_id, completed_at)
  VALUES (NEW.id, v_post_id, NEW.user_id, coalesce(NEW.completed_at, now()))
  ON CONFLICT (generation_id) DO NOTHING
  RETURNING generation_id INTO v_inserted_id;
  IF v_inserted_id IS NOT NULL THEN
    UPDATE public.posts SET remix_count = remix_count + 1 WHERE id = v_post_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.record_completed_post_remix() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER record_completed_post_remix
AFTER INSERT OR UPDATE OF status, output_url ON public.generations
FOR EACH ROW EXECUTE FUNCTION public.record_completed_post_remix();

-- The ledger is the authority, but `posts.remix_count` is what a reader sees,
-- and both foreign keys above cascade. Without this, deleting a remix output
-- (or a moderator removing one) drops its ledger row and leaves the visible
-- count permanently one too high — the reconciling rebuild above only ever
-- runs once, here in this migration.
CREATE FUNCTION public.forget_completed_post_remix()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.posts SET remix_count = greatest(remix_count - 1, 0) WHERE id = OLD.post_id;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.forget_completed_post_remix() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER forget_completed_post_remix
AFTER DELETE ON public.completed_post_remixes
FOR EACH ROW EXECUTE FUNCTION public.forget_completed_post_remix();

-- Old app/server versions may still call this RPC during rollout. Keep the
-- signature but stop incrementing starts so mixed versions cannot inflate it.
CREATE OR REPLACE FUNCTION public.increment_post_remix_count(p_post_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN;
END;
$$;
REVOKE ALL ON FUNCTION public.increment_post_remix_count(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_post_remix_count(uuid) TO service_role;
COMMENT ON COLUMN public.posts.legacy_remix_start_count IS 'Snapshot of editor-open counts before completed-remix accounting on 2026-08-30.';
