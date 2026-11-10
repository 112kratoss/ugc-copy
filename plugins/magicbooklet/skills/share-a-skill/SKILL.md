---
name: share-a-skill
description: Share a skill, a prompt or a guide on Magic Booklet as a text post that carries it as a resource people unlock, on the person's profile, in Explore and in the Marketplace. Use when the person asks to share, publish or sell a skill, a prompt pack or a how-to on Magic Booklet.
allowed-tools:
  - mcp__plugin_magicbooklet_magicbooklet__get_post
---

# Share a skill, a prompt or a guide

A text post on Magic Booklet can carry a resource: cards of text and links that people unlock from the post. That is how a skill, a prompt or a guide is shared there. The post goes out under the person's name, so share only what they chose, and only once they have agreed to the title, the words and who can see it.

If the Magic Booklet tools are missing, the server is not signed in: tell the person to run `/mcp`, pick the magicbooklet server and choose Authenticate.

## 1. What is being shared

Confirm the thing itself: which skill, which prompt or which guide, and that it is the person's to share. Read the file they name and no others.

It becomes readable by strangers, so look through it first for anything that should not leave this machine: keys and tokens, passwords, private addresses and paths, names of clients or colleagues, internal project details. Take those out, and tell the person what you took out before you go on.

A resource holds text and links, never a file. A skill that needs scripts or other files is shared as its instructions, with a link to where the rest lives if the person has one.

## 2. The cards

Each card is one thing a person gets, and a resource holds 1 to 10 of them:

- A guide card for a skill's instructions or a how-to. Its text is the whole of it, up to 50,000 characters.
- A prompt card for a prompt, ready to paste.
- An external link card for an https address, such as a repository or its documentation.

Give each card a title of at most 80 characters that says what it is, such as "Studio product-shot skill", and where it helps a one-line description of at most 120. Everyone sees the titles and descriptions before they unlock the resource; the text and the links only after. So nothing meant to be unlocked goes in a title or a description.

## 3. The post

- A title specific to what is shared, at least 3 characters. Never a placeholder: a public post is refused when its title is made only of stand-in words such as test, demo, draft, sample, example, untitled or placeholder. Show the person the title and use their edit.
- A body that introduces it: what it does, who it is for, how to use it. At most 2,000 characters. The skill itself goes in its card, not here.
- A preview line for the resource, at most 180 characters, saying what it includes. Everyone sees it. Write a real sentence: a public post is refused when its preview says too little, and the one made from the card titles alone is often too short.
- Who can see it: public (their profile, Explore and the Marketplace) or private (only them). Ask; do not assume public.

## 4. Free, unless they ask to sell it

Share it free unless the person asks to sell it.

If they do, the price is theirs to name: a whole number of tokens, 10 or more in steps of 10, where 100 tokens is $1.00. Ask them for it. Then say the price back to them with what a buyer gets, and publish only after they say yes. Never choose a price yourself, and never adjust the one they gave: if it does not fit the rule, tell them the rule and ask again.

Buyers pay the person as they do on the site. A resource is on sale only while its post is public; on a private post it waits as a draft. After publishing, a price or a resource is changed on the website, not by you.

## 5. Publish

Call `publish_post` with the title, the body, the cards as `resources`, the preview and their choices, and with no creation and no uploads. Add the price only if they gave one and said yes. Then give them the post's link.

Keep the post id: the creations list does not show a text post, so the id is how you read it again with `get_post`, which says whether its resource is free or paid and whether it is on offer, never what it holds. If the answer says the post was already published, that is the same post: nothing was posted twice and nothing was changed, the price included.

If the server refuses it, say why and what to change: a placeholder title, a preview that says too little, the daily limit on posts from agents, or a profile with no handle and display name yet, which the person sets on the website. `delete_post` takes a post down for good; where people have already unlocked its resource, the post leaves every public page and they keep their copy. Use it only when the person asks.
