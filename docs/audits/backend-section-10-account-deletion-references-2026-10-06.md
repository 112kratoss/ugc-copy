# Section 10C — purchased legacy generation reference retention

Baseline de100f06 (#374 candidate). Five additional actual local controls cover
retention of a purchased revision's legacy generation inputs, bringing the
account-deletion suite to 27 cases. No runtime or schema change.

The fixture uses a real local GoTrue creator and buyer, a synthetic paid order,
an immutable purchased revision with remix enabled, an inert succeeded generation
and an actual generation_inputs object referenced by generation_input_media.
No generation or payment provider is contacted. Deletion builds the durable
revision supplement while the generation/input rows still exist, copies both
its legacy reference and the purchased attachment into neutral Storage, then
removes the creator's source files and Auth. The supplement survives the cascade;
the buyer's actual entitlement resolves both signed URLs and reads matching
original PNG bytes.

Four transport failure controls interrupt the creator-revision enumeration,
existing supplement read, new supplement persistence and retained-mapping read.
Each rejects initial deletion before any neutral copy or source/Auth removal.
A durable failed job retries, retains both files and preserves the buyer's actual
reads. GET faults retain the SDK's real HTTP 503 retries/backoff; the test timeout
allows them to finish before fixture cleanup. An initial five-second trial
expired during those retries; the complete controls use 30 seconds. A separate
local query confirmed no orphan deletion jobs after the trial. That fixture
timeout is not a product defect.

Five targeted cases and the full 27-case suite pass; the final run takes
147.56 seconds, including the unchanged real lease/grace wait. Test types and
scoped lint pass. Fixture cleanup includes original and neutral
objects, Auth, generation/input rows, purchased snapshots/supplements/mappings,
post/bundle/order/purchase rows, jobs and upload blocks/rate keys.

This closes the named legacy-input retention controls, not all purchased
revision variants or marketplace entitlements. Non-remix input policy, structured
resource variants, multiple/revoked purchases, genuine provider revocation and
deployed browser/proxy behavior remain outside these cases. AUTH-03 and
MARKET-03 remain untested for their broader obligations.

Private logs are .audit-evidence/backend-social/account-deletion-retention*.

All 27 actual controls also pass on Node 24.21.0 (147.26 seconds), matching
the repository runtime. Private evidence: account-deletion-node24.log.
