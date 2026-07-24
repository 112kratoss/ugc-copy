-- Temporary generation inputs are owner-scoped and are served through
-- short-lived signed URLs. A public bucket bypasses read RLS entirely, so the
-- bucket itself must remain private in addition to the existing object
-- policies.
INSERT INTO storage.buckets (id, name, public)
VALUES ('uploads', 'uploads', false)
ON CONFLICT (id)
DO UPDATE SET public = false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM storage.buckets
    WHERE id = 'uploads'
      AND public = false
  ) THEN
    RAISE EXCEPTION 'uploads storage bucket must exist and be private';
  END IF;
END
$$;
