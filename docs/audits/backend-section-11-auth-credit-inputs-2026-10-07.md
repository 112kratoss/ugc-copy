# Section 11X — onboarding and admin credit request bodies

Four failures reproduced through native Request/NextResponse handlers, real local
GoTrue bearer tokens, an HMAC admin cookie with its authoritative SQL session,
PostgREST and PostgreSQL. JSON `null` throws outside the admin credit adapter's
error boundary; onboarding state, welcome claim and onboarding event adapters
return 500 after dereferencing it. Three protected unsigned controls return
private 401 before parsing. Baseline evidence is
`.audit-evidence/backend-social/auth-credit-inputs-before.log`.

The admin adapter now decodes an unknown root and admits only a nonarray object
before its existing required-field validation. The three onboarding handlers
reject null, primitive, array and malformed roots with private 400 responses.
Authentication, the guest welcome-claim gate, anonymous event intake, rate limits,
credit policy, SQL, reviewer identity and valid object responses retain their
existing behavior. No migration or mobile runtime change is included.

All **37 actual Auth/session/PostgREST/SQL cases pass**:

- Four null roots and 24 additional array, number, boolean, string, malformed
  JSON and empty-body controls return private 400 without state, reward or credit
  mutation.
- Three protected unsigned controls and a revoked authoritative admin session
  return private 401. Unsigned invalid event intake remains public and returns 400.
- Valid onboarding state writes preserve completed state on later progress.
- Signed and unsigned valid events write once and ignore duplicate event IDs.
- A real goodwill adjustment records the session reviewer despite a supplied
  reviewer field, replays its idempotency key once, and is reversed through the
  real clawback route. The final fixture balance is restored to 500/0.

Each case checks balances, zero grants, zero durable identity fingerprints and
zero AI usage before cleanup. Separate SQL queries verify zero owned Auth/profile,
admin-session, rate-limit, onboarding-state/event, adjustment, grant, fingerprint
and usage rows afterward. Requests and SQL are guarded to the isolated loopback
stack; no production environment file or external provider is loaded.
Evidence: `.audit-evidence/backend-social/auth-credit-inputs-after.log`.

All **37 focused** onboarding, admin credit policy and mobile contract controls,
app/test types, scoped lint and diff checks pass. The new actual suite runs sequentially in
Quality's isolated API job. Exact candidate/main CI, the standard production
release and independent readback remain required. MAP-02 records this finding
until release; its wider entrypoint/method obligation remains open.

The new suite does not mint a valid welcome grant or certify provider identity
revocation, installed clients, historical incidents or hosted positive admin
requests. Existing focused welcome tests cover valid object and guest logic.
No customer repair or production financial mutation was performed.
