-- Public catalog reads are service-role-only. No provider or price columns cross this boundary.
CREATE INDEX model_catalog_summary_order_idx ON public.generation_model_catalog_entries
  (release_id, ((public_descriptor ->> 'sortOrder')::numeric), model_id COLLATE "C")
  WHERE web_enabled AND mobile_enabled;
CREATE INDEX model_catalog_kind_order_idx ON public.generation_model_catalog_entries
  (release_id, (public_descriptor ->> 'kind'), ((public_descriptor ->> 'sortOrder')::numeric), model_id COLLATE "C")
  WHERE web_enabled AND mobile_enabled;

CREATE OR REPLACE FUNCTION public.read_model_catalog_v1_current()
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT jsonb_build_object('transportVersion', 1, 'descriptorSchemaVersion', 3,
    'revision', r.revision, 'defaults', r.defaults -> 'web',
    'counts', jsonb_build_object(
      'image', count(*) FILTER (WHERE e.public_descriptor ->> 'kind' = 'image'),
      'video', count(*) FILTER (WHERE e.public_descriptor ->> 'kind' = 'video'),
      'motion', count(*) FILTER (WHERE e.public_descriptor ->> 'kind' = 'motion')))
  FROM (SELECT * FROM public.generation_model_catalog_releases WHERE status = 'active'
    ORDER BY schema_version DESC, activated_at DESC LIMIT 1) r
  LEFT JOIN public.generation_model_catalog_entries e ON e.release_id = r.id
    AND e.web_enabled AND e.mobile_enabled AND (e.public_descriptor ->> 'minClientSchemaVersion')::integer <= 3
  GROUP BY r.revision, r.defaults;
$$;

CREATE OR REPLACE FUNCTION public.read_model_catalog_v1_page(
  p_revision text, p_kind text DEFAULT NULL, p_after_sort numeric DEFAULT NULL,
  p_after_id text DEFAULT NULL, p_limit integer DEFAULT 32)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE rid uuid; result jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 51 OR (p_kind IS NOT NULL AND p_kind NOT IN ('image', 'video', 'motion'))
    OR ((p_after_sort IS NULL) <> (p_after_id IS NULL)) THEN RAISE EXCEPTION 'Invalid catalog page arguments'; END IF;
  SELECT id INTO rid FROM public.generation_model_catalog_releases
    WHERE revision = p_revision AND status IN ('active', 'retired') AND activated_at IS NOT NULL;
  IF rid IS NULL THEN RETURN NULL; END IF;
  SELECT coalesce(jsonb_agg(item ORDER BY sort_order, model_id COLLATE "C"), '[]'::jsonb) INTO result FROM (
    SELECT e.model_id, (e.public_descriptor ->> 'sortOrder')::numeric AS sort_order,
      jsonb_build_object('id', e.model_id, 'kind', e.public_descriptor -> 'kind',
        'displayName', e.public_descriptor -> 'displayName', 'description', e.public_descriptor -> 'description',
        'badge', e.public_descriptor -> 'badge', 'recommended', e.public_descriptor -> 'recommended',
        'sortOrder', e.public_descriptor -> 'sortOrder') AS item
    FROM public.generation_model_catalog_entries e WHERE e.release_id = rid AND e.web_enabled AND e.mobile_enabled
      AND (e.public_descriptor ->> 'minClientSchemaVersion')::integer <= 3
      AND (p_kind IS NULL OR e.public_descriptor ->> 'kind' = p_kind)
      AND (p_after_sort IS NULL OR ((e.public_descriptor ->> 'sortOrder')::numeric, e.model_id COLLATE "C") > (p_after_sort, p_after_id COLLATE "C"))
    ORDER BY (e.public_descriptor ->> 'sortOrder')::numeric, e.model_id COLLATE "C" LIMIT p_limit
  ) page;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.read_model_catalog_v1_details(p_revision text, p_ids text[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE rid uuid; release_schema integer; result jsonb;
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) < 1 OR cardinality(p_ids) > 8 THEN RAISE EXCEPTION 'Expected 1-8 model ids'; END IF;
  SELECT id, schema_version INTO rid, release_schema FROM public.generation_model_catalog_releases
    WHERE revision = p_revision AND status IN ('active', 'retired') AND activated_at IS NOT NULL;
  IF rid IS NULL THEN RETURN NULL; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('modelId', e.model_id, 'descriptor', e.public_descriptor,
    'releaseSchemaVersion', release_schema)), '[]'::jsonb) INTO result
  FROM public.generation_model_catalog_entries e WHERE e.release_id = rid AND e.model_id = ANY(p_ids)
    AND e.web_enabled AND e.mobile_enabled AND (e.public_descriptor ->> 'minClientSchemaVersion')::integer <= 3;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.read_model_catalog_v1_current() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_model_catalog_v1_page(text,text,numeric,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_model_catalog_v1_details(text,text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_model_catalog_v1_current() TO service_role;
GRANT EXECUTE ON FUNCTION public.read_model_catalog_v1_page(text,text,numeric,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_model_catalog_v1_details(text,text[]) TO service_role;
