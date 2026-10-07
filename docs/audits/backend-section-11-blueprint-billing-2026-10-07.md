# Section 11R — blueprint billing, replay and settlement replies

October 7, 2026. This extends WORKFLOW-03/04 evidence in the 11Q candidate.
Nine actual local GoTrue/PostgREST/SQL cases pass without a further runtime
change. The combined authoring and billing suites pass 25 cases. Exact-head CI,
parent release and final deployment verification remain required.

The real blueprint service uses signed fixture identities, the service-role
ledger and rate-limit RPCs. Only provider responses are controlled. Each fixture
starts with 50 total credits, including ten promotional credits; quoted planning
cost is six. The tests check both credit buckets, ledger state, persisted response
and provider invocation count through these boundaries:

- Successful work charges six once, stores the result and returns the same result
  on duplicate replay without another submission. Direct client settlement denies.
- The same request key under two different identities creates two separate owned
  events; neither identity reuses the other's paid response.
- A concurrent duplicate sees the actual committed pending hold while the first
  controlled provider callback waits at a barrier. It returns 409, then replays
  the completed response after release. There is one event, hold and submission.
- A failed submission refunds both credit buckets exactly once. Repeated refund
  returns already-refunded; the failed request key is terminal. A new key starts
  one new paid attempt and holds only its quoted cost.
- Malformed JSON and non-string provider content each refund the original
  promotional allocation; duplicates do not submit again.
- A controlled 503 replaces the response only after actual success settlement
  commits in PostgREST. Independent SQL confirms succeeded/not-refunded and a
  stored result. The first service call returns 500; retry replays success, with
  one charge/submission and no competing refund.
- Insufficient credits and mismatched header/body request keys reject before
  ledger insertion or provider submission.

Both production ledger routine definitions and anon/authenticated/service grants
match the local API database read-only. The production metadata is the verified
3f04cb16 snapshot; the mapping/worker parent adds no schema changes. No hosted
billing operation is performed. Each case independently verifies zero fixture
Auth users, profiles, usage events and rate-limit rows after exact-ID cleanup.
Non-loopback API/database targets and every external HTTP request are refused.

The success-reply fault proves actual database commit followed by a replaced HTTP
reply. It does not prove a real network interruption or process death. Actual
provider submission, Storage, crashes before submission, stale pending holds and
external reconciliation remain outside these cases. Provider delivery is still
external; broader workflow conservation and method matrices stay open. Private
logs and definition/role parity are under `.audit-evidence/backend-social/`.
