# Section 2 — notification table ownership

Status: reproduced and fixed locally; production release pending.

Scope: `mobile_notifications`, `mobile_notification_preferences` and
`mobile_push_tokens`. This does not certify Expo delivery/retry behavior,
physical-device delivery, the rest of Section 2, or the entire backend.

## Finding and fix

The API requires registered accounts for inbox, preferences and token
registration. Anonymous Supabase sessions nevertheless have the authenticated
Postgres role, and the three tables checked only row ownership and active
identity. An active guest could directly insert a push token, upsert its
preferences, and read/update its own existing notification/preferences/token
rows. This is a registered-account boundary bypass; no foreign-account read or
write was reproduced. Existing notification content is still protected by the
column grant that permits only `is_read` updates.

The new migration adds restrictive registered-identity policies on all three
tables, using the authoritative auth row rather than client metadata. It also
explicitly retains the active-session gate on clean databases. Existing owner
policies and grants remain intact. Service-role maintenance retains access to
historical guest rows. No customer data is rewritten; DDL lock acquisition is
bounded to five seconds. Existing API services already reject guests, including
unregister through the route admission policy.

## Validation

- Production pre-fix reproduction: a real anonymous identity could read its own
  fixture notification directly; expected zero rows, received one. The verifier
  stopped at that failed assertion and removed all three fixture identities.
- Before the fix: 9 failures in 40 database assertions. Eight demonstrate guest
  access/mutation; the ninth is a downstream fixture count changed by the
  unexpected successful guest insert.
- After the fix: 40/40 database assertions pass, including owner-only reads,
  foreign updates, notification content protection, token ownership changes,
  guest writes, revoked sessions, banned identities and service access.
- Clean replay: 253 migrations; all 76 database test files / 1,469 assertions pass.
- Focused migration and notification service tests: 24 passed; focused lint,
  script syntax and whitespace checks passed.
- The existing money-policy test now counts only its six financial tables,
  instead of incorrectly treating that policy name as globally exclusive.
- Live verifier: `scripts/ops/verify-notification-table-boundaries.mjs`. Creates
  two registered identities and one real anonymous identity. Uses only inert
  tokens and direct fixture inbox inserts; disables fixture push preferences;
  creates no delivery jobs. Verifies API preference/inbox/read/register/
  unregister compatibility, foreign isolation, guest denial and revocation,
  then deletes all three identities and their dependent rows.

Previous deployed batch: `backend-section-02-social-marketplace-release-2026-09-27.md`.
