-- A cash refund revokes the purchase and updates its order atomically, then
-- decrements only the bundle's sales counter. That metadata write must not be
-- rejected by the content freeze while Storage/Auth erasure is retrying.
CREATE OR REPLACE FUNCTION public.reject_post_resource_bundle_write_during_account_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Referential maintenance and nested wallet/moderation triggers keep their
  -- existing exemption. Direct creator content writes still remain frozen.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.sales_count > 0 AND NEW.sales_count = OLD.sales_count - 1
       AND (to_jsonb(NEW) - ARRAY['sales_count', 'updated_at'])
         IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['sales_count', 'updated_at']) THEN
      -- No owner, price, publication, content, resource path or wallet amount
      -- changes here. In particular, a capture's counter increment is blocked.
      RETURN NEW;
    END IF;
  END IF;

  IF public.is_account_deletion_requested(NEW.owner_user_id)
    AND NOT EXISTS (
      SELECT 1 FROM public.posts
      WHERE id = NEW.post_id AND review_status = 'hidden'
    ) THEN
    RAISE EXCEPTION 'Account deletion is already in progress'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.reject_post_resource_bundle_write_during_account_deletion() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reject_post_resource_bundle_write_during_account_deletion() FROM PUBLIC, anon, authenticated, service_role;
