---
name: create-ugc-ad
description: Make a UGC-style ad video or image on Magic Booklet from a product brief, with the person's credits, then offer to publish it. Use when the person asks for a UGC ad, a product video, a hook or an ad creative made with Magic Booklet.
allowed-tools:
  - mcp__plugin_magicbooklet_magicbooklet__list_models
  - mcp__plugin_magicbooklet_magicbooklet__get_model
  - mcp__plugin_magicbooklet_magicbooklet__quote_generation
  - mcp__plugin_magicbooklet_magicbooklet__get_generation
  - mcp__plugin_magicbooklet_magicbooklet__list_creations
---

# Create a UGC ad with Magic Booklet

Turn the person's brief into a finished video or image on their Magic Booklet account. Every run spends their credits, so price it first and start nothing they have not agreed to at that price.

If the Magic Booklet tools are missing, the server is not signed in: tell the person to run `/mcp`, pick the magicbooklet server and choose Authenticate.

## 1. The brief

Ask only for what is missing: the product, who the ad is for, the hook (the first one or two seconds), the format (a vertical 9:16 video unless they say otherwise, or a still), the length, and any product photo to start from. A starting image must be one of their own. For one of their creations, find it with `list_creations`, then call `get_generation` on it and pass the output URL that answer gives: not the preview or the page link `list_creations` shows. For a file of theirs, `upload_input` gives an `asset_id`. Other web addresses are refused.

## 2. The model

Call `list_models` with `kind` set to `video` or `image` and keep its `catalog_revision`. Pick a model that fits the brief (`defaults` names the one each kind opens on), then call `get_model` for its settings and inputs. Tell the person which model you chose in one line, and let them pick another.

## 3. The prompt

Write the prompt yourself, in the model's idiom: the product and the person holding or using it, the setting and the light, the camera and its movement, and the hook in the opening beat. Phone-camera realism reads as UGC; studio polish reads as stock. `enhance_prompt` rewrites a prompt for the model, but each call charges a fixed amount with no quote, so ask before you use it.

## 4. The price, then the question

Call `quote_generation` with the kind, `model_id`, settings and `input_counts` you will create with. Quoting is free. Tell the person the cost (`cost_credits`) and their balance (`balance_credits`), and wait for a clear yes. If `affordable` is false, say how many credits they are short and that they can top up on magicbooklet.com. Never try to sell them credits.

## 5. Create

Only after the yes, call `create_media` with:

- the quote's `cost_credits` as `expected_cost_credits`, and its `catalog_revision`;
- a UUID you mint as `idempotency_key`. Keep it: after a timeout or a dropped connection the run may have started, so a retry reuses the same key and never a new one, which would start and charge a second run.

If the answer is `COST_CHANGED`, nothing was charged: tell the person the new price and ask again before you create at it. `INSUFFICIENT_CREDITS` states the shortfall.

## 6. Wait

Call `get_generation` with the `generation_id` and `wait_seconds` 30, and again while `settled` is false. Images finish within a minute and videos take a few minutes, so tell the person it is running rather than going quiet. A failed run gives its credits back by itself: say why it failed and offer a change.

## 7. Deliver, then offer to publish

Give the person the permanent magicbooklet.com link (the signed media URL expires within the hour). Then offer to publish it as a post, and if they want to, follow the publish-creation skill. Never publish without their yes.
