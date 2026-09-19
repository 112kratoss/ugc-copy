# Creations reliability supporting evidence

This document contains the evidence behind the [Creations reliability audit and implementation plan](creations-reliability-plan.md).

## Device

- Device: Samsung SM-S928B, Android 16
- App: Magicbooklet 0.1.4, build 71
- Running update shown in Settings: `0558882d` (prefix only)
- API build checked during the audit: `3697696d23673485eaf9a6b38403b3db679937f4`
- Source checkout reviewed: `c9bc1542f82b2d423675570c75231d627bf326c9`

## Reproduced navigation failure

The grid contained a creation labelled “File no longer available”. Tapping it opened the first unrelated creation in the viewer. The cause is that the grid keeps the unavailable item, while the viewer filters items without media and falls back to index zero.

This was reproduced on the connected phone. The expected regression is: tapping an unavailable item must open that item's own unavailable state, never another creation.

## Media and production checks

For the affected account at audit time:

- 61 generation rows
- 44 succeeded and unarchived
- 1 source-unavailable row
- 43 available successful rows
- 43/43 available rows had ready previews and matching preview objects in Storage
- 30 image rows, of which 23 had display renditions and 7 did not
- 7 video rows; no video row was missing a ready playback rendition

Storage logs for 2026-09-15 17:20–17:50 UTC showed 41 image requests from the matching Android model user agent, all HTTP 200, plus two Media3 requests, also HTTP 200. This does not prove that the original blank-media incident was not a client-side stall, proxy failure, or native cache issue; no matching Vercel proxy trace was captured.

## Repeat-open check

Six grid → feed → viewer cycles were run on the physical phone across two images and one video. All selected titles matched the opened viewer item. Two cycles included background and resume. The intermittent global blank-media state did not recur during this short warm-cache run.

## Diagnostic checks

Five desired-contract checks were run against the reviewed source. All five failed before the fixes are implemented:

1. unavailable creation preserves its identity;
2. display-image rendition survives the owner-generation adapter;
3. archived creations do not enter the normal Creations viewer;
4. cached data preserves its original freshness timestamp;
5. an owner-post enrichment failure does not discard successful creation data.

## Raw evidence

The original raw XML screenshots, device cycle records, memory snapshots, and diagnostic output were collected during the audit. The main plan contains the findings and acceptance criteria; this supporting document records the readable evidence summary so it can be opened directly from the active checkout.
