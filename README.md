# pfb — Prototype Feedback for Claude Code

Work through feedback pinned with the [Prototype Feedback](https://chromewebstore.google.com/detail/prototype-feedback/lkpciiloidfgdhlgaefcbggajlfljmbp) Chrome extension, inside Claude Code.

## Install

Needs Claude Code and Node.js 18+ (21+ to run the plugin's own tests) (`node --version`).

```bash
claude plugin marketplace add leslurb/prototype-feedback-claude-plugin
claude plugin install pfb@prototype-feedback
```

## Use

1. In the extension, press **Send to Claude Code** (0.7.0+) or **Export for LLM** (0.6.0).
2. In Claude Code, inside the prototype's repo, type `/pfb:feedback`.

Claude lists waiting batches, shows a plan, and after your OK fixes each comment on a new `feedback/<site>-<date>` branch, one commit per comment.

## Versions

Claude Code caches a plugin by its version. Every user-visible change bumps `version` in `.claude-plugin/plugin.json` (the MCP server reports the same number) and gets a `vX.Y.Z` git tag. To get a new version: `claude plugin update pfb@prototype-feedback`, then start a new session.

- 0.2.0: repo matching (`repo_match`, `repo_remember`), short batch ids, listener accepts extension requests without an Origin, an unknown extension can read its 403 (the extension then shows "refused (HTTP 403)"), branch names drop a `:port`.
- 0.1.0: first release.

## Where files go

Everything lives in your Downloads folder (override with `PFB_DOWNLOADS`):

| Path | What |
|---|---|
| `prototype-feedback/inbox/` | sends from extension 0.7.0+ |
| `prototype-feedback_*.zip` | 0.6.0 exports, picked up too |
| `prototype-feedback/batches/<id>/` | unpacked batches + `responses.json` |
| `prototype-feedback/archive/` | ZIPs after unpacking |
| `prototype-feedback/status.json` | per-comment status |

If Chrome's "Ask where to save each file" setting is on, Chrome asks where to save even for "Send to Claude Code". Save into `Downloads/prototype-feedback/inbox/`, or turn the setting off. A ZIP saved anywhere else is not found by `/pfb:feedback`.

While a Claude Code session is open, the plugin serves status read-only on `127.0.0.1:41837` to the extension only (Origin check). Nothing leaves your machine.
