---
name: publish-creation
description: Publish one of the person's finished Magic Booklet creations as a post on their profile and in Explore, under a real title. Use when the person asks to post, share or publish something they made on Magic Booklet.
allowed-tools:
  - mcp__plugin_magicbooklet_magicbooklet__list_creations
  - mcp__plugin_magicbooklet_magicbooklet__get_generation
  - mcp__plugin_magicbooklet_magicbooklet__get_post
---

# Publish a creation as a post

A post goes out under the person's name, on their profile and in Explore. Publish only the creation they chose, and only once they have agreed to its title and who can see it.

If the Magic Booklet tools are missing, the server is not signed in: tell the person to run `/mcp`, pick the magicbooklet server and choose Authenticate.

## 1. Pick the creation

If they named one (a link, an id, or the run you just made), use it. Otherwise call `list_creations` and show the newest finished ones (`status` succeeded) with their links, and let them choose. A creation marked `posted` already has a post: ask before posting it again.

## 2. Write the title

Write a short title specific to what the creation shows, such as "Iced matcha pour in morning light". Never a placeholder: a public post is refused when its title is made only of stand-in words such as test, demo, draft, sample, example, untitled or placeholder (with or without words like "my", "new" or a number), and any title with lorem, ipsum or asdf. Show the person the title and use their edit.

## 3. The choices

- Who can see it: public (their profile and Explore) or private (only them). Ask; do not assume public.
- A description, if they want one.
- Remixes: by default the post carries the creation's recipe, its prompt and inputs, free, so others can remix it. Ask whether they would rather not allow remixes.
- Mark it as sensitive only when it is.

## 4. Publish

Call `publish_post` with the creation's `generation_id` and those choices, then give them the post's link. If the server refuses it (a placeholder title, the daily limit on posts from agents, or moderation), say why and what to change. `delete_post` takes a post down again; use it only when they ask.
