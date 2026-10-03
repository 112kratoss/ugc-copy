# Section 7C — downstream completion and refund/retry accounting

Date: October 3, 2026. Local verification only; no runtime change. Builds on
Section 7A and publication candidate 7B. WORKFLOW-02/03 remain open for canvas,
process restart and additional interleavings.

The template database fixture now dispatches image and video nodes to their
actual start services, with controlled settings (`nano-banana-2` image and
`kling-3.0-video`, five seconds, standard mode). Provider transport/admission,
status polling, media transport and the workflow node executor remain fixtures.
The run worker, generation reservation, credits, settlement and canonical result
recording are real application code and service-role PostgreSQL functions.

Two new cases pass:

1. Two image settlements, both checkpoint approvals, one video start, duplicate
   worker ticks, duplicate video-success settlement and canonical run completion.
   The final generation ID is stored on the run; later ticks/cancellation keep
   it succeeded. Exactly three generations and their original charges remain.
2. Downstream video failure settles twice but refunds once. Successful image
   charges remain. Duplicate manual retry creates one replacement video. Its
   success completes the run, counts the images plus the successful replacement,
   and excludes the refunded failed video. Repeated reads/ticks add no charge.

All 19 database cases pass on isolated port 55322, together with test TypeScript
and targeted lint. Independent readback finds zero fixture templates/runs.
A first fixture attempt mistakenly selected a motion-only model for the video
start and failed; correcting the fixture to a real video model resolved it.
This is not a product defect or a paid provider test. Logs are in
`.audit-evidence/backend-section-07/full-lifecycle-*.log`.

These cases do not prove actual provider delivery, physical worker death,
Storage cleanup, real node-input mapping, or every canvas/template action order.
