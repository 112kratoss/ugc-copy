-- PostgreSQL has no built-in object-length helper for jsonb. The provider map is
-- constrained to be a JSON object, so direct equality with the empty object is
-- the exact empty-map check intended by the original publisher.
CREATE OR REPLACE FUNCTION public.publish_generation_model_catalog(
  p_release_id uuid,
  p_expected_active_revision text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  target public.generation_model_catalog_releases%ROWTYPE;
  current_revision text;
  platform_name text;
  kind_name text;
  default_model_id text;
BEGIN
  SELECT * INTO target
  FROM public.generation_model_catalog_releases
  WHERE id = p_release_id
  FOR UPDATE;

  IF target.id IS NULL OR target.status NOT IN ('draft', 'shadow') THEN
    RAISE EXCEPTION 'The target catalog release is not publishable';
  END IF;

  SELECT revision INTO current_revision
  FROM public.generation_model_catalog_releases
  WHERE schema_version = target.schema_version AND status = 'active'
  FOR UPDATE;

  IF p_expected_active_revision IS NOT NULL
    AND current_revision IS DISTINCT FROM p_expected_active_revision THEN
    RAISE EXCEPTION 'The active catalog revision changed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.generation_model_catalog_entries WHERE release_id = p_release_id
  ) THEN
    RAISE EXCEPTION 'A catalog release must contain at least one model';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.generation_model_catalog_entries entry
    JOIN public.generation_models model ON model.model_id = entry.model_id
    WHERE entry.release_id = p_release_id
      AND (
        entry.public_descriptor ->> 'id' IS DISTINCT FROM entry.model_id
        OR entry.public_descriptor ->> 'kind' IS DISTINCT FROM model.kind
        OR jsonb_typeof(entry.public_descriptor -> 'controls') IS DISTINCT FROM 'array'
        OR jsonb_typeof(entry.public_descriptor -> 'capabilities') IS DISTINCT FROM 'object'
        OR jsonb_typeof(entry.public_descriptor -> 'inputs') IS DISTINCT FROM 'object'
        OR entry.provider_model_map = '{}'::jsonb
      )
  ) THEN
    RAISE EXCEPTION 'One or more catalog entries are invalid';
  END IF;

  FOREACH platform_name IN ARRAY ARRAY['web', 'mobile'] LOOP
    FOREACH kind_name IN ARRAY ARRAY['image', 'video', 'motion'] LOOP
      default_model_id := target.defaults -> platform_name ->> kind_name;
      IF default_model_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM public.generation_model_catalog_entries entry
        JOIN public.generation_models model ON model.model_id = entry.model_id
        WHERE entry.release_id = p_release_id
          AND entry.model_id = default_model_id
          AND model.kind = kind_name
          AND CASE WHEN platform_name = 'mobile' THEN entry.mobile_enabled ELSE entry.web_enabled END
      ) THEN
        RAISE EXCEPTION 'Invalid % default for %', kind_name, platform_name;
      END IF;
    END LOOP;
  END LOOP;

  UPDATE public.generation_model_catalog_releases
  SET status = 'retired', retired_at = timezone('utc'::text, now())
  WHERE schema_version = target.schema_version AND status = 'active';

  UPDATE public.generation_model_catalog_releases
  SET status = 'active', activated_at = timezone('utc'::text, now()), retired_at = NULL
  WHERE id = p_release_id;

  RETURN jsonb_build_object(
    'status', 'published',
    'releaseId', p_release_id,
    'revision', target.revision,
    'previousRevision', current_revision
  );
END;
$$;

REVOKE ALL ON FUNCTION public.publish_generation_model_catalog(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_generation_model_catalog(uuid, text)
  TO service_role;
