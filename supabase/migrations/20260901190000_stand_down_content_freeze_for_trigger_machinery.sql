-- Second regression in the account-deletion content freeze, same shape as
-- 20260901175000 but earlier in the pipeline: the owner-already-gone
-- exemption only helps once the auth.users row is deleted, and
-- auth_users_anonymize_post_comments_before_delete is a BEFORE DELETE
-- trigger. It soft-removes the user's comments and decrements
-- posts.comment_count -- and when a removed comment sat on the user's own
-- post, that UPDATE reached the freeze while the auth row still existed, so
-- the freeze raised 55000 and rolled the whole account deletion back
-- (production, 2026-09-01 18:40 UTC, verified from the postgres error
-- context). Any account that ever commented on its own post was
-- undeletable.
--
-- Distinguish by origin instead of by owner liveness: a direct API write
-- fires these triggers at pg_trigger_depth() = 1, while every piece of
-- machinery the freeze must not block -- referential SET NULL maintenance,
-- cascade deletes answered with counter updates, and auth.users
-- BEFORE/AFTER trigger bookkeeping -- reaches them from inside another
-- trigger, at depth >= 2. No trigger copies caller-controlled content into
-- posts or post_resource_bundles, so trigger-driven writes cannot smuggle
-- new content past the freeze.

CREATE OR REPLACE FUNCTION public.reject_post_write_during_account_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Trigger-driven machinery (RI maintenance, auth.users delete
  -- bookkeeping, counter sync) must pass or account erasure rolls back.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  -- Moderation must still be able to retract or restore an entitlement while
  -- deletion is pending. User-authored post mutations do not control this
  -- column, so a review-status transition is the narrow safe exemption.
  IF public.is_account_deletion_requested(NEW.user_id) THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'Account deletion is already in progress'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    IF NEW.review_status IS NOT DISTINCT FROM OLD.review_status THEN
      RAISE EXCEPTION 'Account deletion is already in progress'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_post_resource_bundle_write_during_account_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Same origin rule as posts: cascade and trigger machinery passes, direct
  -- writes stay frozen.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF public.is_account_deletion_requested(NEW.owner_user_id)
    AND NOT EXISTS (
      SELECT 1
      FROM public.posts
      WHERE id = NEW.post_id
        AND review_status = 'hidden'
    ) THEN
    RAISE EXCEPTION 'Account deletion is already in progress'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.reject_post_write_during_account_deletion()
  OWNER TO postgres;
ALTER FUNCTION public.reject_post_resource_bundle_write_during_account_deletion()
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.reject_post_write_during_account_deletion()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reject_post_resource_bundle_write_during_account_deletion()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.reject_post_write_during_account_deletion() IS
  'Freezes direct user post writes while a deletion job exists; trigger-driven maintenance passes.';
COMMENT ON FUNCTION public.reject_post_resource_bundle_write_during_account_deletion() IS
  'Freezes direct user bundle writes while a deletion job exists; trigger-driven maintenance passes.';
