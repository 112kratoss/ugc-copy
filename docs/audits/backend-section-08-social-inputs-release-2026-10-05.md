# Section 8G — malformed social input release

PR #346 passed all four Quality jobs in 37231029795 and merged as
`44864e5667eb6a9ed7d81bcc6faa5138590a8767` on October 4 at 20:57:31 UTC.
No mobile store release was active immediately before merge. Exact-main Quality
37234106785 passed; standard release 37234741646 succeeded at 21:10:17 UTC.
Independent exact live SHA, feed 200, admin auth redirect 307 and unsigned webhook
401 checks pass. Private live evidence is under
`.audit-evidence/backend-social/social-input-release/`.

The seven endpoint corrections and reproduction evidence are documented in
[the input report](backend-section-08-social-inputs-2026-10-05.md): thirteen prior
HTTP 500 responses, all 28 actual local HTTP checks passing afterward, fourteen
permanent adapter controls, 69 focused web and 130 mobile contract cases.
No migration, historical data repair or mobile runtime release was needed.
SOCIAL-02/04 return to untested for their broader matrices; this release does not
certify every successful request, request size bound or lifecycle transition.
