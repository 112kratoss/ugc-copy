# UI Changes Plan

## Overview
Redesign the app UI to support three generation modes: **Motion Control**, **Image Generation**, and **Video Generation**.

## Current State
- Single creation flow at `/create` focused on motion control (image + reference video → output video)
- Dashboard shows generated videos only

## Planned Changes

### Navigation / Mode Selection
- Add a mode selector on the create page (tabs or cards) for:
  - 🎭 **Motion Control** — current feature (image + video → animated video)
  - 🖼️ **Image Generation** — text/prompt → image
  - 🎬 **Video Generation** — text/prompt + optional image → video

### Create Page
- Each mode shows its own input form:
  - **Motion Control**: image upload + video upload + prompt (current flow)
  - **Image Generation**: prompt + style options
  - **Video Generation**: prompt + optional image upload + duration options
- Shared components: prompt input, progress/status display, result preview

### Dashboard
- Filter/tabs to view outputs by type (all / images / videos / motion)
- Thumbnail previews for images, video player for videos

### Pricing
- Update credit costs per generation type if different

## Status
- [ ] Design mockups
- [ ] Mode selector component
- [ ] Image generation form
- [ ] Video generation form
- [ ] Rename current flow to "Motion Control"
- [ ] Dashboard filters by type
- [ ] Update pricing display
