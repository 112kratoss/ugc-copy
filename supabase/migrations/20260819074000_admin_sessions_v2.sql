-- Server-authoritative sessions for the single-operator admin console.
--
-- The signed cookie is deliberately only the edge admission hint. Node route
-- handlers re-check this table so logout revocation and password-hash rotation
-- take effect even when a copied cookie has not expired yet.

CREATE TABLE IF NOT EXISTS public.admin_sessions (
  session_id uuid PRIMARY KEY,
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 128),
  credential_version text NOT NULL
    CHECK (credential_version ~ '^[A-Za-z0-9_-]{43}$'),
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT admin_sessions_expiry_after_creation
    CHECK (expires_at > created_at),
  CONSTRAINT admin_sessions_revocation_after_creation
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX IF NOT EXISTS admin_sessions_active_expiry_idx
  ON public.admin_sessions (expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE public.admin_sessions ENABLE ROW LEVEL SECURITY;

-- No RLS policy is created. Only the service role is allowed to operate on
-- these rows; browser Data API roles must not enumerate or forge sessions.
REVOKE ALL ON TABLE public.admin_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_sessions TO service_role;

COMMENT ON TABLE public.admin_sessions IS
  'Service-role-only authoritative admin login sessions; signed cookies are not sufficient authorization.';
