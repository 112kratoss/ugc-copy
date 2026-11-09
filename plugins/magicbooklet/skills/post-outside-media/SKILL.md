---
name: post-outside-media
description: Post a picture or video the person made outside Magic Booklet, with another tool or their own camera, on their profile and in Explore, saying what made it. Use when the person asks to post, share or upload media that was not made on Magic Booklet.
allowed-tools:
  - mcp__plugin_magicbooklet_magicbooklet__get_post
---

# Post media made elsewhere

A post goes out under the person's name, on their profile and in Explore. This skill posts media that was not made on Magic Booklet: a picture or a video from another tool, or a file of their own. Post only the files they chose, and only once they have agreed to the title, to what made the media and to who can see it.

If the Magic Booklet tools are missing, the server is not signed in: tell the person to run `/mcp`, pick the magicbooklet server and choose Authenticate.

Media made on Magic Booklet is not for this skill: a creation is published from its generation id, which carries its own model and recipe.

## 1. The files

A post takes 1 to 5 pictures or videos, in the order they will show, and no audio. Confirm which files, and that they are the person's to post.

## 2. Stage each file

- A link (a public https address): call `upload_input` with `url`. A picture may be 25 MB and a video 50 MB at most.
- A file on this machine: say which file you are about to send, then call `request_upload` with its name, its type and its exact size in bytes (`wc -c < FILE` gives it). The answer holds one curl command: run it with the file's path in place of FILE and wait for it to finish, then call `upload_input` with the upload id that answer gave. The same size limits apply.

Each `upload_input` answer names the staged file's `storage_path`. Keep them in order. A staged file is kept about two hours and is used up by the post, so stage right before you publish. If a file is refused (a type Magic Booklet does not take, or a size or type that differs from what you declared), say why and fix that file; do not swap in another without asking.

## 3. The words

- A title specific to what the media shows, such as "Paper-cut fox in a snowy forest". Never a placeholder: a public post is refused when its title is made only of stand-in words such as test, demo, draft, sample, example, untitled or placeholder (with or without words like "my", "new" or a number), and any title with lorem, ipsum or asdf. Show the person the title and use their edit.
- What made it: the tool, and its model or version where it has one (Midjourney v7, Photoshop, a phone camera). Ask; never guess, and never name Magic Booklet, which did not make it.
- Who can see it: public (their profile and Explore) or private (only them). Ask; do not assume public.
- A description or a note, if they want one. Mark it as sensitive only when it is.

## 4. Publish

Call `publish_post` with `uploads` (each file's `storage_path`, in order), the title, `made_with` and their choices, then give them the post's link. Keep the post id: the creations list does not show a post made this way, so the id is how you read it again with `get_post`. If the answer says the uploads were already published, that is the same post, and nothing was posted twice.

If the server refuses it (a placeholder title, the daily limit on posts from agents, a name it does not take as what made the media), say why and what to change. `delete_post` takes a post down for good, with its media; use it only when they ask.
