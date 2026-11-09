# Magic Booklet for Claude Code

Create AI images and videos with your [Magic Booklet](https://magicbooklet.com) credits from Claude Code, every run priced before it starts, publish them as posts, and post media you made elsewhere.

The plugin adds:

- **The Magic Booklet MCP server**, `https://magicbooklet.com/api/mcp`, signed in through Magic Booklet's own Claude Code client.
- **`/magicbooklet:create-ugc-ad`**: a UGC ad from brief to finished video or image. It picks a model, prices the run, asks you, creates, waits for the result and offers to publish it.
- **`/magicbooklet:publish-creation`**: publishes one of your creations as a post, under a real title, once you have agreed to it.
- **`/magicbooklet:post-outside-media`**: posts a picture or video you made with another tool, from a link or from a file on your computer, saying what made it, once you have agreed to it.

Claude also uses the skills by itself when you ask for a UGC ad, to post a creation or to post media made elsewhere.

## Install

```bash
claude plugin marketplace add 112kratoss/ugc-copy
```

```bash
claude plugin install magicbooklet@magicbooklet
```

Then, in Claude Code, run `/mcp`, pick the magicbooklet server and choose **Authenticate**. Your browser opens on Magic Booklet; sign in if you need to and allow Claude Code. Signing in listens on port 8976, so keep that port free while you do it.

The marketplace lives in Magic Booklet's app repository. To check out only the plugin's folders, add it with `--sparse`:

```bash
claude plugin marketplace add 112kratoss/ugc-copy --sparse .claude-plugin plugins
```

[magicbooklet.com/developers/mcp](https://magicbooklet.com/developers/mcp#claude-code) sets the server up without the plugin, and in the other clients it supports. Use the plugin or a server you added yourself, not both.

## Your credits and your account

- Pricing a run is free, and Claude shows you the price before it creates. A run is never charged more than the price it was confirmed at: if the price changes, nothing is charged and Claude asks again. A failed run refunds itself.
- Prompt enhancement is the one fixed charge with no price step, and the skill asks before using it. Agents cannot buy credits; top up on magicbooklet.com.
- You approve the connection on Magic Booklet, and you can disconnect it under Connected apps on your profile. The sign-in lasts an hour and renews only while the connection stands; Claude Code never sees your password.

## Maintainers

- The plugin's MCP server is declared in `.claude-plugin/plugin.json` (`mcpServers`), not in a `.mcp.json`: this repository's agent guard refuses every `.mcp.json` to its agents, which would leave the file unreadable to a reviewer.
- `src/__tests__/mcp-distribution-manifests.test.ts` holds the server URL, the client id and the callback port to `src/lib/mcp-client-directory.ts`, and these install commands to the setup page's.
- Bump `version` in `.claude-plugin/plugin.json` with every change to the plugin: an installed copy updates only when the version changes. It stays `0.x` while the Claude Code client id is a placeholder, and the test requires `1.0.0` or later once the real id is in.
- Check the manifests with `claude plugin validate .` from the repository root, and `claude plugin validate plugins/magicbooklet`.
