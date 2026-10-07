# Section 11T — admin moderation input parsing and session boundaries

October 7, 2026. This attaches a new reproduced finding to SOCIAL-03.
Twelve actual local session/PostgREST cases initially have six failures and six
passing unsigned controls. Null request bodies expose a TypeError message from
post/subject-report decisions and proactive post moderation, return 500 from
generation moderation/contact triage, and throw outside the sanctions handler's
error boundary. No privileged business mutation occurs in those reproductions.

The candidate treats decoded bodies as unknown and admits only a JSON object
before reading action fields. Other roots and unreadable JSON take the existing
missing-field 400 paths after authoritative admin authentication. Valid objects,
reviewer attribution, rate limits and mutation services are unchanged. Three
route adapter modules change; no migration or mobile contract changes.

All **60 actual local API cases** pass:

- Six null regressions and six unsigned controls.
- Twenty-four array/number/string/unreadable-JSON controls after valid admission.
- Eighteen denied revoked, missing or expired database sessions. The signed
  cookie remains valid; the stored row is authoritative. Expiry timestamps are
  explicitly aged, not an elapsed wall-clock test.
- Six valid-action cases with actual SQL: post hide/restore and duplicate key;
  post/subject report dismissal and stable duplicate audit fields; generation
  remove/restore and duplicate key; contact handle/reopen and stable duplicate
  fields; user suspension/reinstatement and duplicate key. A forged body reviewer
  never replaces the real session reviewer in the stored audit record.

The fixture session uses the real HMAC credential version and persisted admin
session row, with a real disposable GoTrue reviewer. Requests invoke native
handlers directly. Feed cache invalidation is controlled; posts are text-only
and generations are inert terminal fixtures without media/provider work. No
customer or actual money operation is involved.

All **33 focused cases**, app/test types, scoped lint and diff checks pass.
Every case checks unchanged 500-credit fixture balances and independently empty
Auth/profile/session/rate/post/generation/contact/report/audit fixtures after
exact-ID cleanup. Initial expanded fixtures violated the existing expiry-order
and self-report constraints; they were corrected without weakening constraints
or changing application behavior. A final cleanup-strengthening run also exposed
fixture clock skew in revocation timestamps; `greatest(created_at, now())` keeps
the existing constraint intact. The corrected full run passes all 60 cases,
including zero audit/usage cleanup. All earlier logs remain private.

Read-only production inspection finds five exact routine definition matches and
matching signatures/execute grants for all six routines (anon/authenticated
denied, service role admitted). `apply_admin_post_moderation` has a different raw
digest: the API database and clean replay contain four explicit `uuid[]` casts
on empty array literals that production omits. The complete definitions differ
only at those four casts. Same-engine controls confirm equal UUID-array types
and values for null/empty/nonempty COALESCE inputs and equal PL/pgSQL initial
assignments. This is a reviewed cast-only difference, not exact digest parity;
no production or migration definition is changed to erase it.

Exact-head CI, parent release, standard deployment and independent live/source/
schema/advisor verification remain required. Actual hosted moderation, Storage
take-down/reconciliation, cache propagation and the wider sanctions/reporting
matrix remain open. SOCIAL-03 stays **failed** until this candidate is verified
released, then returns to untested for that broader scope.
