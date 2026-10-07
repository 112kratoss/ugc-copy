# Section 11M — isolated backup and credit reconciliation rehearsal

Read-only production backup metadata at October 7 02:56 UTC reports seven
completed physical backups in `ap-south-1`, most recently October 6 23:25:36 UTC.
WAL-G is enabled and PITR is disabled. This confirms backup availability metadata,
not that a selected production backup has been restored successfully. The query
uses the documented [Management API backup endpoint](https://supabase.com/docs/reference/api/v1-list-all-backups).

An actual local logical backup/restore rehearsal passes at 03:12:39 UTC. Its
source is the owned clean-replay database; its target is a new PostgreSQL 17.6
container with no network or published ports. An exported repeatable-read
snapshot captures two synthetic Auth identities and one SQL-only credit receipt.
The second synthetic receipt arrives after that backup. No provider request,
customer record, production restore or production balance change occurs.

The restored snapshot preserves all row counts and row digests across 167 tables
in public/Auth/Storage/migration-history schemas. It also preserves 175 relation
owners and normalized ACL sets, 356 routine owners/ACLs, 15 role authorities and
23 memberships. All 940 public constraints retain their metadata and semantics;
15 of 16 raw schema-class fingerprints agree exactly. PostgreSQL flattens nested
AND expressions in ten CHECK constraints during logical restoration, so their
raw definition fingerprint differs. Each original definition is independently
reparsed by the same engine on a temporary copy of its restored table and must
produce the exact restored definition. No generic parentheses removal or ignored
permission/constraint mismatch is used.

Actual restored service-role calls preserve the original 500-credit purchase on
duplicate replay, reject another account's claim, then reconcile the missing
post-backup receipt once to reach 1,000 credits. A second replay adds no credits.
Anonymous/authenticated reads of the private receipt table remain denied. These
are synthetic SQL delivery controls; they do not establish genuine provider
delivery, account login, or recovery of an installed client's purchase intent.

The successful 2.6 MB local archive takes approximately 281 ms to dump and
1,080 ms to restore after target/bootstrap readiness. These timings exclude
environment creation and operator response and are not production RPO/RTO claims.
Separate cleanup restores every source table's row digest to its pre-fixture
baseline. The complete owned target environment is retired after all probes;
the private archive and evidence are preserved.

The early cold-image attempts exposed required platform setup: restore authority
for Supabase-owned schemas, missing global roles and the managed extension-owned
GraphQL wrapper. The successful harness includes password-free global role
definitions, uses the target's private bootstrap administrator, installs the
exact source wrapper after extension creation, and restores its ACLs. It also
normalizes ACL order for comparison. Initial authentication/SQL harness errors
and failed checks remain preserved, each with complete source cleanup. No applied
migration or production permission was changed to make the rehearsal pass.

This is a local certificate. The local and live schema snapshots still differ
in column order, installed extensions and functions; it is not a restored copy
of the current production database. OPS-02 remains untested for its full scope:
restore an actual managed production backup into an approved isolated environment,
verify encrypted/Auth/configuration dependencies, and exercise deployment rollback
and external reconciliation. [Supabase's managed clone documentation](https://supabase.com/docs/guides/platform/clone-project)
also identifies configuration and Storage objects requiring separate setup and
external extensions that can run when a clone starts. A separate current production
read at 03:24:52 UTC finds Vault 0.3.1, no cron relation or HTTP queue, and zero
enabled database HTTP triggers. That observation does not certify an older
physical backup or replace isolation for a restore exercise. The launch's accepted
absence of independent Storage recovery remains explicit in the deployment runbook.

Private evidence, reproducible harness, snapshots, failures and cleanup are under
`.audit-evidence/backend-social/backup-restore/`. The 53-row checklist remains
24 passed, 26 untested, one failed and two external. This does not close OPS-02,
MEDIA-07, provider-dependent delivery, or the full backend audit.
