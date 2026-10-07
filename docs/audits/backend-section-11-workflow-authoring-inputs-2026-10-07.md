# Section 11Q — workflow authoring admission and malformed input

October 7, 2026. Runtime baseline is verified production
`3f04cb16f9435d8a20735a2ac7ca7514db9ddb3a`; parent #392 adds only mapping and
worker tests. Status: reproduced validation defects, candidate passes local
verification; exact candidate CI and release remain pending. The findings attach
to WORKFLOW-04, which is failed until independently verified deployment.

## Reproductions

The real local GoTrue, PostgREST, service-role rate-limit RPC and authenticated
RLS clients exercise the actual handlers using native Requests and Responses.
Nine cases fail before the change, while six existing controls pass:

- Canvas PATCH with JSON `null` throws when the service reads `body.title`.
  Array, number, string and malformed JSON roots are accepted with HTTP 200
  because the adapter treats them as updates or converts parse failure to `{}`.
- Blueprint POST with a number in product name, audience or primary message
  returns HTTP 500 when validation calls `.trim()` on that number.
- Blueprint POST with malformed JSON returns HTTP 500 from its outer error
  handler instead of a validation response.

These are local reproductions, not attributed customer incidents. Native handler
invocation does not claim a networked Next deployment or browser reproduction.

## Candidate and verification

Canvas PATCH now requires a parsed object before calling the save service.
Invalid roots and unreadable JSON return private/no-store 400 after the existing
authentication and rate-limit checks. Blueprint parsing failure uses the existing
invalid-input response, and required fields must be nonempty strings before
privileged rate limiting, credit holds or provider submission. Valid request
shapes, pricing, ownership, idempotency and the database remain unchanged.

All 16 actual Auth/PostgREST cases pass, including the nine regressions and these
additional boundaries: owned create/list/read/save/publish/history restore/delete,
foreign reads and writes, direct foreign RLS reads/updates, six unauthenticated
read/write handlers, share preview/import into another owner's private canvas,
and a real anonymous Auth identity owning/editing/deleting its canvas. Foreign
DELETE retains its existing generic success response while changing no owner row.

The 38 focused service/adapter cases, app/test types, scoped lint and diff checks
pass. [11R billing controls](backend-section-11-blueprint-billing-2026-10-07.md)
add nine actual replay/refund/concurrency/settlement-reply cases without another
runtime change; the combined suite passes 25 actual API cases. The new API suite is added sequentially to the existing isolated CI API
job; exact-head Linux CI must certify it before merge. No migration or installed
mobile operation contract changes: these authoring routes have no operation
entry in the current mobile API contract.

Each actual case preserves its fixture balances at 500 with no AI usage event,
then independently verifies zero fixture users, profiles, canvases, history,
shares and usage records after cleanup. Local configuration is explicit; tests
reject non-loopback database/API hosts and every HTTP request outside the local
API origin. No `.env.local`, provider key, paid request, customer mutation or
production write is used. Raw before/after logs are private in
`.audit-evidence/backend-social/workflow-authoring-*.log`.

This closes only the reproduced input defects once released. It does not verify
provider planning, actual Storage snapshots, generated HEAD/OPTIONS, hosted proxy
admission, proposal generation or the full workflow method/ownership matrix.
WORKFLOW-04 then returns to untested for its wider scope; no audit signoff.
