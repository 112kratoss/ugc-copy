# Creator profile HTTP visibility — October 4, 2026

Thirteen actual local Next HTTP checks pass with disposable Auth users and five
real database posts. No new runtime defect was established by this matrix.

- Anonymous reads return the public creator projection without email or balances.
- Only visible, public, unarchived posts appear; private, hidden and archived posts
  are excluded even when the creator reads their own public page.
- Two one-item pages are disjoint, with correct `hasMore` transitions.
- Anonymous responses use public caching and vary on Authorization; signed-in
  reads use private no-store headers.
- Actual persisted follow state appears in the response.
- A block in either direction returns 404 to the signed-in viewer; anonymous public
  reads remain available, as specified by the public-profile boundary.
- A missing creator returns 404.

The initial fixture referenced nonexistent `user_follows` rather than `follows`;
the error and seven completed controls were preserved. The corrected complete run
passes 13/13. Both runs removed fixture posts and Auth users and checked user
absence. Identity-keyed rate entries were also removed. No production mutation,
provider request, notification delivery or client UI verification was involved.

Private scripts/logs are `.audit-evidence/backend-social/creator-http-*`.
This is additional SOCIAL-01/03/04 evidence, not full closure: share events,
profile media, moderation transitions, request byte limits and remaining API/page
entrypoints still need evidence. The development server was stopped afterward.
