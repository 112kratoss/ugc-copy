# Section 8A — concurrent follow retry release

October 4, 2026. [PR #336](https://github.com/112kratoss/ugc-copy/pull/336)
passed all four Quality jobs in 37199243395 on
`263f9741bb0b26fe6747b36c340d8db6233a6cca`. No mobile store release was active
immediately before merge. It merged at 11:47:23 UTC / 17:17:23 IST as
`e6d8e81d54c3cef8bf0b5d7b68d42c245639b03e`.

Exact-main Quality 37199914979 passed, then standard production release
37200570697 succeeded at 12:03:46 UTC / 17:33:46 IST. Independent checks at
12:05:16 UTC verified the same live build, feed 200, admin login redirect 307
and unsigned webhook 401. Evidence is retained in
`.audit-evidence/backend-social/release/`.

The [follow retry fix](backend-section-08-follow-retries-2026-10-04.md) is deployed.
No migration or client runtime change was required. The broader SOCIAL-02 row
remains open: subsequent real database probes reproduce save counter drift on
account deletion and concurrent legacy toggles. Notification delivery and the
remaining social lifecycle matrix are not certified by this release.
