# Section 11S — template publication with Auth, Storage and SQL

October 7, 2026. Sixteen actual local API cases pass with real GoTrue identities,
PostgREST mutations, immutable-version SQL and Storage copies. No application or
migration change is required. This extends WORKFLOW-04 and MEDIA-08 evidence;
exact-head CI and final release verification remain required.

The tests exercise native route handlers directly. Each case has two disposable
registered identities with 500 credits, a real owned canvas, a draft template
and a one-pixel PNG in local Storage. A terminal successful test run is an
explicit SQL fixture; no generation is executed or provider called.

The cases cover:

- Owned draft creation, listing and update, including reuse of the same canvas
  draft; foreign and unsigned reads/mutations deny without copied assets.
- Rights confirmation, exact revision/hash and successful test requirements,
  including failed and non-test runs.
- Actual immutable activation and public projection without authoring fields;
  a signed demo URL returns the original PNG bytes. A correctly shaped direct
  authenticated activation call denies with SQL permission error 42501.
- Three reply faults injected only after independent SQL observes committed
  activation: 504, malformed JSON and missing insertion metadata. The version
  stays active and its copied object remains readable. Retry reuses that same
  version and removes the new redundant copy.
- Actual SQL constraint rejection after Storage copy. No version activates,
  copied assets are removed, and a later retry succeeds after removing the
  fixture-only failure trigger.
- Missing and foreign demo source rejection before activation.
- Two publishers held at a rejecting deadline until both copies exist and both
  requests reach activation. SQL commits one version and the losing copy is
  removed. Disabling discovery retains the immutable version/assets and the
  owner's private view while denying foreign public detail reads.

Both production activation and immutability routine definitions and role grants
match the local API database read-only. Every case verifies unchanged fixture
balances, no AI usage, and zero owned Auth/profile/canvas/template/version/run/
rate-limit/Storage fixtures after cleanup. The separate fixture Auth namespace
check is zero. Immutable local fixture versions are removed with trigger bypass
limited to one exact-owner cleanup transaction; no production fixture is used.
The rejecting concurrency barrier also passes its final focused check. Test
types, scoped lint and diff checks pass.

Reply replacement follows a real database commit; it is not an actual network
outage or worker death. The handlers are not served by a hosted Next process.
Actual generated test provenance, video encoding/poster failure, fixed-asset
variants and hosted provider delivery remain separate evidence requirements.
WORKFLOW-04 and MEDIA-08 stay open. Private logs and definition/role readback
remain in `.audit-evidence/backend-social/`.
