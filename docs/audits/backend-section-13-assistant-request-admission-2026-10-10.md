# Section 13A — workflow assistant request admission

An authenticated assistant-message request with JSON `null` throws a TypeError
while reading `body.content`, before returning an error response. The regression
runs the real route adapter, Auth verification and PostgREST-backed identity
admission against the isolated local stack. After correcting a separate test
expectation about stale-proposal discard, 24 controls pass and the null-body
case alone fails on the original code (`assistant-auth-reproduction.log`).

The message service now accepts an unknown request body and rejects non-object
JSON roots with HTTP 400 before reading fields, querying canvas state, taking a
rate-limit slot or charging credits. Valid message objects retain the existing
content validation and idempotency parsing. There is no migration or successful
response contract change.

Twenty-five real Auth/PostgREST controls pass after the fix:

- Foreign, unsigned and invalid bearer requests across assistant state, message,
  apply and discard handlers (12 cases).
- Nine malformed message bodies, including null, arrays, primitives, invalid
  JSON, missing content, object content and whitespace.
- Reading the newest 100 messages chronologically and the owned proposal without
  changing state.
- Owned apply/discard and duplicate/opposite-action refusals.
- Stale-revision refusal while preserving the canvas and history and recording
  the proposal's intentional discard.

Every case verifies unchanged purchased/promotional balances, no usage ledger
entries and no external requests. Exact cleanup verifies the fixture canvas,
proposals, messages, history and rate-limit rows; suite cleanup verifies deleted
Auth users. No provider call or proposal generation is simulated by these tests.
The first run's stale-revision assertion wrongly required the proposal to remain
ready; correcting it to the existing deliberate discard behavior changed only
the test, not application behavior.

The final actual suite passes all 25 cases in 1.41 seconds. Seventeen focused
service/adapter cases also pass, including six non-object service controls.
App/test typechecks, scoped lint and diff checks pass. The actual suite is wired
into the sequential Supabase API job. Private evidence is
`.audit-evidence/backend-social/assistant-auth-*`.

WORKFLOW-04 remains failed pending this candidate's standard release and
independent verification. Provider-generated proposals, message persistence
failure/acknowledgement recovery, complete billing conservation, hosted session
admission and the broader workflow matrix remain open. This is a bounded input
fix with additional identity/state evidence, not assistant subsystem sign-off.
