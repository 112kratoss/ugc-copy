# Section 12G — verified media reservation and account credit release

PR #413 merged as `6766777860d3099478948b57ef7f14b4d63295f5` on October 8,
2026 at 14:09:42 UTC. Candidate Quality 37787974905 and exact-main Quality
37790197606 passed all five jobs. Standard production release 37791925353
succeeded. Independent verification at 14:27:25 UTC confirms the exact live SHA,
both tested runtime sources, unchanged schema and all 112 security findings.
Live version and feed returned 200; unsigned admin access redirected to login
(307), and the unsigned Kie webhook was rejected (401).

Six actual local Storage/PostgREST/SQL controls cover unused media reservations,
lease-owner/attempt/terminal fencing, rejected writes and lost acknowledgements.
The CI-discovered account-credit display race has a deterministic before/after
regression; all 25 account/shell tests pass without weakening existing checks.
A delayed old-account refresh is now invalidated at the auth transition and
checked again when React applies the state update. No stored balances change.
No database migration or customer repair was required for this release.

The first PR candidate and main each failed the same pre-existing account test.
The corrected candidate passed. Another actor's main rerun also passed; before
merging, the audit reverified that newer parent's standard release, schema,
permissions and smoke checks, and checked that no mobile store release was active.

The full JOB-02 obligation remains failed for a separate newly reproduced upload
reclaim progress defect: 500 protected uploads can block a later reclaimable
object on repeated sweeps. MEDIA-08/09 and broader recovery remain open. Private
12G evidence is in `.audit-evidence/backend-social/media-rendition-budget-release/`.
