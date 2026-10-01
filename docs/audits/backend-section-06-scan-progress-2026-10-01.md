# Section 6L — staging reclamation past persistent entries

Status: PR #256 merged as `999c34d5b3435d160865a05c8ba3ff1bd3a0ec29`;
PR/main Quality and standard production release passed first run. Deployed and
verified at 12:50:32 UTC (18:20:32 IST); independent live checks passed. See
[release evidence](backend-section-06-scan-progress-release-2026-10-01.md).
Baseline: `5934bd7dac80d402d4db5e274e2716a60432790a`.

## Reproduced failure

Section 6K placed 128 unpublished workspaces ahead of two dead published owners
in actual Linux directory order. Ten passes reclaimed zero; 1,843,200 reclaimable
bytes remained on a 2 MiB tmpfs and the next import failed with ENOSPC. A new
real-filesystem regression also fails on the baseline: a fresh process returns
zero instead of reclaiming the two trailing owners. No mocked directory ordering
is used. This is a local fault injection, not a production incident claim.

## Change and design choice

A pass now stops after 128 successful reclamations, rather than after examining
128 entries. Preserved active, unpublished, malformed or foreign entries do not
consume that budget. The existing inherited-lock and publication checks still
control deletion. An early marker metadata check cheaply rejects unpublished
entries; marker contents and identity requirements are still validated under the
exclusive lease before removal.

Directory iteration uses Node's streaming `opendir` iterator; it does not collect
or sort the namespace. See [Node filesystem documentation](https://nodejs.org/docs/latest-v24.x/api/fs.html#class-fsdir).
No process-local cursor, disk journal or new native dependency is introduced.
Fresh workers can reach the tail immediately, including when no space is
available to create cursor metadata. More than 128 dead workspaces drain over
successive passes because each pass removes the successfully reclaimed prefix.

**The budget now bounds reclamations, not total inspection or elapsed time.**
Enumeration and validation are linear in namespace size. This explicitly relaxes
the old 128-entry inspection bound to fix persistent starvation without a durable
queue protocol. A process-local cursor would repeat the prefix after cold starts;
a disk cursor adds publication/ENOSPC/crash consistency obligations. Simply raising
the cutoff would retain the same defect at another threshold. A new indexed
namespace would require migration and stronger metadata lifecycle rules.

The choice preserves immediate progress through the reproduced persistent set.
It does not guarantee latency or fairness under arbitrary continuous mutation,
and it does not close metadata accumulation/shared disk admission. Those remain
MEDIA-06/07 and OPS-03. Local scan-cost measurements accompany this batch; they
are not a Vercel capacity certificate. There is no age/name-based deletion of
unpublished or legacy workspaces.

## Verification

- Baseline new regression: expected two reclaimed workspaces, observed zero.
- Fresh-process regressions cover an unpublished 128-entry prefix, a locked
  128-entry prefix with preserved bytes, and a 140-owner backlog reclaimed as
  128 then 12 by separate processes.
- Existing inherited-reader, concurrency, marker, symlink and retry tests remain.
- The updated Linux/Node 24.21.0 2 MiB disk probe reclaims both trailing owners on
  its first pass. The next import succeeds and all 128 unpublished fixtures stay.
  Sequential killed owners and active/inherited-reader ENOSPC protection also pass.
- 23 focused tests pass; full web suite: 6,176 passed, 118 DB/child-only skips.
  App/test typing and targeted lint pass. The focused suite was rerun after the
  marker precheck; CI verifies the complete final tree.
- Isolated fresh-process scan samples with the full web suite idle: 128 unpublished
  entries 9–11 ms, 1,000 entries 43–66 ms, 10,000 entries 400–405 ms (three samples
  each, process startup excluded). Earlier full-validation scans took roughly
  2.85–3.05 seconds for 10,000 entries. A run during the full web suite was
  materially slower and is retained separately; these are descriptive local
  samples, not a controlled production performance guarantee.
- The original 6K probes remain immutable; the updated probe and timing scripts,
  native image build log, and baseline/final tests are preserved under 6L.
- PR Quality `36853752909`, exact-main Quality `36862814234` and standard
  release `36864062596` passed first run; details are in the release evidence.

Private evidence: `.audit-evidence/backend-section-06l/`. This batch carries the
Section 6J release records and Section 6K investigation/initial closure ledger.
No SQL migration, mobile runtime/OTA change, provider charge, production fixture
or customer repair is involved. Unrelated local changes remain separate.
