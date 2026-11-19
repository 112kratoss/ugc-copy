# Magic Booklet for Claude Code

Create AI images and videos with your [Magic Booklet](https://magicbooklet.com) credits from Claude Code, every run priced before it starts, publish them as posts, post media you made elsewhere, and share prompts, guides and skills.

The plugin adds:

- **The Magic Booklet MCP server**, `https://magicbooklet.com/api/mcp`, signed in through Magic Booklet's own Claude Code client.
- **`/magicbooklet:create-ugc-ad`**: a UGC ad from brief to finished video or image. It picks a model, prices the run, asks you, creates, waits for the result and offers to publish it.
- **`/magicbooklet:publish-creation`**: publishes one of your creations as a post, under a real title, once you have agreed to it.
- **`/magicbooklet:post-outside-media`**: posts a picture or video you made with another tool, from a link or from a file on your computer, saying what made it, once you have agreed to it.
- **`/magicbooklet:share-a-skill`**: shares a skill, a prompt or a guide as a text post that carries it for people to unlock. It is free unless you ask to sell it, and then at a price you name and confirm.

Claude also uses the skills by itself when you ask for a UGC ad, to post a creation, to post media made elsewhere or to share a skill, a prompt or a guide.

## Install

```bash
claude plugin marketplace add 112kratoss/magicbooklet-claude-plugin
```

```bash
claude plugin install magicbooklet@magicbooklet
```

Then, in Claude Code, run `/mcp`, pick the magicbooklet server and choose **Authenticate**. Your browser opens on Magic Booklet; sign in if you need to and allow Claude Code. Signing in listens on port 8976, so keep that port free while you do it.

Added the marketplace earlier, from another repository? Claude Code keeps a marketplace under the source it was first added from, so remove it, which also removes the plugin and what it saved:

```bash
claude plugin marketplace remove magicbooklet
```

Then run the two commands above, and sign in with `/mcp` again if Claude Code asks.

[magicbooklet.com/developers/mcp](https://magicbooklet.com/developers/mcp#claude-code) sets the server up without the plugin, and in the other clients it supports. Use the plugin or a server you added yourself, not both.

## Your credits and your account

- Pricing a run is free, and Claude shows you the price before it creates. A run is never charged more than the price it was confirmed at: if the price changes, nothing is charged and Claude asks again. A failed run refunds itself.
- Prompt enhancement is the one fixed charge with no price step, and the skill asks before using it. Agents cannot buy credits; top up on magicbooklet.com.
- You approve the connection on Magic Booklet, and you can disconnect it under Connected apps on your profile. The sign-in lasts an hour and renews only while the connection stands; Claude Code never sees your password.

## Maintainers

The plugin is kept in Magic Booklet's app repository, beside the server it drives, where tests hold the two together. It is published from there to [github.com/112kratoss/magicbooklet-claude-plugin](https://github.com/112kratoss/magicbooklet-claude-plugin), the repository people install from, so a change made in that one would be overwritten: write to info@magicbooklet.com with a problem or a suggestion.

- The plugin's MCP server is declared in `plugins/magicbooklet/.claude-plugin/plugin.json` (`mcpServers`), not in a `.mcp.json`.
- `version` in that file rises with every change to the plugin: an installed copy updates only when the version changes.
- `claude plugin validate --strict .` from the repository root checks the marketplace, and `claude plugin validate --strict plugins/magicbooklet` the plugin and its skills.
