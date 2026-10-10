# Cove UI refinement — 2026-09-19

## Reference and scope

Use Finder's persistent locations/navigation and readable file rows, Apple Music's library/list hierarchy, and the existing IINA-inspired playback controls.

- https://support.apple.com/guide/mac-help/organize-your-files-in-the-finder-mchle9f0a1b2/mac
- https://support.apple.com/guide/music/customize-the-music-window-mus0cec331d6/mac
- https://iina.io/

This pass updates library chrome, homepage, file locations and music browsing. It does not add picture-in-picture, miniature players or other unimplemented player features.

## Changes

- Neutral dark content surfaces, translucent navigation, smaller radii, consistent blue primary actions and readable secondary text.
- Compact homepage destinations, recent playback above storage locations, matching DOM and visual order.
- Direct page titles and counts replace promotional text.
- A storage location or source selection no longer simultaneously marks the parent library active. Long sidebar names truncate with a full-name tooltip.
- Music library has a Play action and hover/focus play affordances. Narrow windows retain track, folder and size columns; source and format remain available at wider sizes.
- Existing music/video playback styling remains in its dedicated stylesheets.

## Validation

- TypeScript and Vite production build passed.
- Existing 24 tests passed (media grouping, playback queues and storage validation).
- Browser visual inspection: homepage at 1280×720; music library, movie library and file locations at 900×640. Demo data was used, not personal storage credentials.
- Native packaging/install verification recorded separately in the task result.
- Final native bundle signed and verified with 48 embedded libraries; installed at `/Applications/Cove.app` and reopened successfully. Installed executable hash matches build output.
- Native app displays the new homepage/music layout; existing 416 video works, 534 songs and storage accounts remain present.
- Previous app backup: `.audit-backup/Cove-before-ui-20260919-211717.app` (ignored by Git).
- Music sorting, no-result disabled Play state and reset filters verified in browser.
