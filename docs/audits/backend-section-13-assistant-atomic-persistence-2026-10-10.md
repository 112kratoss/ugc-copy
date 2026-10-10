# Section 13B — atomic assistant persistence and credit settlement

The assistant could discard the previous usable proposal before saving its
replacement. Actual SQL-trigger failures reproduce three inconsistent outcomes:
a rejected proposal insert loses the old ready proposal; a rejected message
insert leaves the new proposal without its conversation; and a rejected discard
is ignored, allowing two ready proposals and a successful charge. The first six
route-level controls pass three and fail three against the original service.
Transport-failure and actual SQL-failure reproductions are retained separately.

The new service-only `complete_workflow_assistant_message` transaction saves the
replacement proposal, both messages and successful usage settlement together.
Any failed write rolls back the replacement and preserves the previous proposal.
It locks the matching owned usage event and serializes replacements per canvas.
It does not take a parent canvas row lock ahead of existing proposal locks.
The service reads the durable outcome after a failed or malformed completion
reply: a committed success is returned; an unavailable read returns a retryable
error without attempting an uncertain refund. Existing settlement locks prevent
refunding an already successful event.

Migration `20261010073728_atomic_workflow_assistant_message.sql` adds one invoker
function, executable only by `service_role`. Anonymous and authenticated direct
calls are denied. The pending event must match the user, feature and stored
5,000-character input preview. Completed RPC retries also check canvas identity.
The route's existing idempotency-key scope is unchanged; this is not a claim of
full cross-canvas key isolation. Full message content is retained beyond the
ledger preview. No applied migration is edited.

Fifteen actual Auth/PostgREST/SQL controls pass:

- One successful charge, one message pair and same-key replay.
- Provider refusal and malformed content refund once and preserve prior state.
- Rejected discard, proposal insert, message insert and success settlement each
  roll back all result writes and restore the original credit buckets.
- Lost and malformed replies after commit recover the saved success.
- A lost reply combined with unavailable recovery reads keeps the successful
  charge; the same key replays when reads recover, without another provider call.
- Concurrent same-key requests create one event; distinct keys create two paid
  conversations with only one proposal remaining ready.
- Anonymous/authenticated RPC denial, direct completed replay, mismatched owner
  and canvas refusal, and content beyond the ledger preview boundary.

The suite uses actual local Auth, native requests, PostgREST and PostgreSQL.
Only the Kie response and selected completion/read transport failures are
intercepted. Provider telemetry persistence is stubbed, and external requests
are forbidden. SQL write failures come from fixture-scoped database triggers.
Each test removes its Auth user and verifies zero remaining profile, usage,
canvas, proposal, message and rate-limit fixtures. No provider is charged.

Validation: 40 combined admission/billing cases, 19 focused service/adapter and
migration cases, and all 2,382 SQL assertions across 113 files pass. The final
migration replays from a clean isolated database; six SQL controls verify its
roles and missing-event refusal. App/test typechecks and scoped lint pass.
The existing sequential assistant API CI step includes both actual suites.
Private evidence is `.audit-evidence/backend-social/assistant-billing-*`.

WORKFLOW-04 remains failed pending standard release and independent verification
of 13A and 13B. Hosted provider behavior, process death before persistence,
stale holds, cross-canvas key reuse and the wider assistant/workflow matrix remain
separate audit obligations. The local failure injection does not establish a
production incident or justify a customer balance repair.
