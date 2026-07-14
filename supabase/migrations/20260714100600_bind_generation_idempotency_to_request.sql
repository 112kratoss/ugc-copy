CREATE TABLE IF NOT EXISTS public.generation_start_requests (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key_hash text NOT NULL CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  PRIMARY KEY (user_id, key_hash)
);

ALTER TABLE public.generation_start_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.generation_start_requests FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS "No client access to generation start requests" ON public.generation_start_requests;
CREATE POLICY "No client access to generation start requests"
  ON public.generation_start_requests
  FOR ALL TO public
  USING (false)
  WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.claim_generation_start_request(
  p_user_id uuid,
  p_key_hash text,
  p_request_hash text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_request public.generation_start_requests%ROWTYPE;
BEGIN
  IF p_user_id IS NULL
     OR p_key_hash !~ '^[a-f0-9]{64}$'
     OR p_request_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid generation start idempotency claim';
  END IF;

  INSERT INTO public.generation_start_requests (user_id, key_hash, request_hash)
  VALUES (p_user_id, p_key_hash, p_request_hash)
  ON CONFLICT (user_id, key_hash) DO NOTHING;

  SELECT * INTO v_request
  FROM public.generation_start_requests
  WHERE user_id = p_user_id
    AND key_hash = p_key_hash
  FOR UPDATE;

  IF v_request.request_hash IS DISTINCT FROM p_request_hash THEN
    RETURN 'payload_mismatch';
  END IF;

  UPDATE public.generation_start_requests
  SET updated_at = timezone('utc'::text, now())
  WHERE user_id = p_user_id
    AND key_hash = p_key_hash;

  RETURN 'claimed';
END;
$$;

REVOKE ALL ON FUNCTION public.claim_generation_start_request(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_generation_start_request(uuid, text, text) TO service_role;
