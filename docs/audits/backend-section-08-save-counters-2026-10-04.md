# Section 8B — save counters through deletion and concurrency

October 4, 2026. Obligation: SOCIAL-02. Based on main e6d8e81d, after the
[8A follow fix release](backend-section-08-follow-retries-release-2026-10-04.md).

## Reproduced failures

1. Deleting a saver from Auth cascades its `post_saves` rows but leaves
   `posts.save_count` unchanged. This reproduces for public, private and archived
   posts and when other savers remain. Account deletion uses Auth's admin delete
   API; counter maintenance previously ran only inside the save RPCs.
2. Two legacy toggle requests can both read the same existing row and both
   subtract one even though only one DELETE removes a row. With another saver
   present, the count becomes zero while that person's save remains. A row-lock
   barrier reproduces this deterministically.
3. Two legacy toggles against an initially absent save race their INSERTs,
   causing one to fail. A table-lock barrier reproduces the conflict. Legacy
   toggle remains a supported API behavior when no explicit state is supplied.

The eight-case permanent baseline fails six cases and passes two controls.
Twelve final database cases cover these failures, explicit retry, rollback,
owner deletion, deletion racing both unsave forms and denied client RPC access.

A bounded production rollback probe independently reproduces the deletion drift:
2/4 controls pass before release, with zero fixture users on separate cleanup
readback. Its first draft had an ambiguous probe variable; the corrected run is
recorded separately. A read-only aggregate found nine mismatched counts among
38 posts, net difference +9. These existing mismatches are not attributed to a
specific cause and are not repaired by this migration.

## Fix

Both save RPCs acquire the same transaction advisory lock for a saver/post pair
before deciding how to mutate it. Legacy toggles consequently execute in order;
two toggles return to the initial state. The legacy unsave path now decrements
only when DELETE actually removed its row.

A private definer trigger runs before Auth deletion. It deletes that identity's
save rows and decrements each affected post by the rows actually removed, updating
post IDs in sorted order. Concurrent unsave owns its decrement only if it won
that DELETE. Other savers remain intact. The cleanup and Auth deletion roll back
together. Its empty search path and revoked direct execute privileges preserve
the service boundary; neither RPC's client grants or signature are widened.

Migration: `20261004114652_maintain_post_save_counters.sql`, created with the
pinned CLI and a captured UTC stamp. No historical counter backfill or mobile
runtime change. A fresh production-ledger plan identifies exactly this one
pending migration and no ordering conflict.

## Evidence and limits

- Clean isolated replay on port 55332 succeeds; all 1,960 pgTAP assertions pass.
- All 12 database cases pass on the clean replay. The concurrency cases are wired
  into Quality's database job, not merely skipped in the ordinary web suite.
- The actual local Auth admin API removes a fixture account and leaves zero saves
  and zero count. Fixture accounts are created through Auth; an initial direct
  SQL account fixture was invisible to that API and was corrected.
- A separate rolled-back comment probe passes eight owner/foreign identity,
  parent-depth, parent-removal, private-post and role-denial controls. Three
  earlier save/comment sequential controls also pass. These are partial social
  evidence, not a complete comment or account-deletion audit.

Private logs, probes and snapshots are in `.audit-evidence/backend-social/`.
The normal audit API/Storage stack at 55321/55322 and the primary workspace's
5432x stack are preserved; clean replay uses a separate disposable database.
Docker was restarted after its daemon stopped; the failed connection attempt is
not counted as a migration or test pass. Candidate CI and release are pending.
SOCIAL-02 remains failed until the reproduced defects and existing drift are
resolved; other identity/recovery and social behavior obligations remain open.
