# Section 8H — share controls release

Tests/evidence PR #348 passed all four Quality jobs in 37234612545 and merged
as `360d62496aa3dc91ffc97cb7ed0139a024a8f726` on October 4 at 21:18:35 UTC.
No mobile store release was active immediately before merge. Exact-main Quality
37235572061 passed. Standard release 37236449862 succeeded at 21:35:08 UTC;
independent exact live SHA, feed 200, admin auth redirect 307 and unsigned webhook
401 checks pass. Private smoke evidence: `.audit-evidence/backend-social/share-release/`.

This batch added the bounded share attribution/lifecycle tests and recorded prior
release evidence. No runtime change, migration or mobile release was needed.
Its thirteen PostgREST/SQL cases ran explicitly locally; normal CI validates the
suite's types but skips transport execution without the isolated API configuration.
Ten actual Next HTTP assertions also passed locally. These limits and remaining
coverage are documented in the share-boundaries report.
