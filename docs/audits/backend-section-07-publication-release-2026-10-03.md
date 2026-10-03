# Section 7B — publication acknowledgement release

October 3, 2026. PR #291 merged as `34e8387f731a1cba9b976845d0524f7366589af8`
at 08:54:15 IST. No mobile store release was active before merge.

The fix preserves publication assets when activation may have committed but its
reply is lost. Definitive mutation rejection still removes candidate assets.
Read `backend-section-07-publication-acknowledgement-2026-10-03.md` for the
reproduction, actual SQL commit/readback proof and controlled Storage boundary.

- PR Quality 37059027223: all four jobs passed.
- Exact-main Quality 37093085015: all four jobs passed, including 6,670 web
  tests (141 skipped), 2,913 mobile tests, 24 browser cases, 1,960 SQL assertions
  in 91 files, 142 database cases (one child-harness skip), native checks and
  163 packaged runtime traces. Main includes the intervening notification PR.
- Standard production release 37093737713: first attempt passed, including
  staged and protected live health. Completed 03:39:46 UTC / 09:09:46 IST.
- Independent live check: exact build ID `34e8387f`, public feed 200, admin
  payout authentication redirect 307, unsigned provider callback 401.

Private release JSON and independent smoke readback are under
`.audit-evidence/backend-section-07/publication-release/`. These checks certify
release and public boundaries, not a real production template publication or
provider transaction. WORKFLOW-04 and MEDIA-08/09 remain open.
