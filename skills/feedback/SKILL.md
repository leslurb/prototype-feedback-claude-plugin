---
name: feedback
description: Work through Prototype Feedback batches (pinned review comments with screenshots) in this repo. Use when the user types /pfb:feedback or asks to work on prototype feedback, review comments from the extension, or the feedback inbox.
---

# /pfb:feedback

Work through feedback that reviewers pinned on a prototype with the Prototype Feedback Chrome extension. Tools come from the `pfb` MCP server: `inbox_list`, `batch_open`, `status_set`. If those tools are missing, tell the user the plugin's MCP server did not start and that it needs `node` on PATH (`node --version`), then stop.

If `inbox_list`, `batch_open` or `status_set` returns an error, show the error to the user and stop. Never continue as if it succeeded.

## 0. Preconditions
1. Run `git rev-parse --is-inside-work-tree`. If it fails, tell the user this command needs a git repo, and stop.
2. Run `git remote get-url origin`. If it fails, skip repo matching in step 1.2 and say so.
3. Run `git status --porcelain`. If it prints anything, ask the user to commit or stash first, and stop. Do this before any planning.
4. Run `git symbolic-ref -q HEAD`. If it prints nothing, HEAD is detached. Tell the user before you create a branch.

## 1. Pick a batch
1. Call `inbox_list`. Show the batches as a short table: id, state (waiting / in_progress / done / error), exported date in ET, comment counts by verb (fix, change, ask, idea) and urgent count.
2. For a batch in state `error`, show its error text and tell the user the file could not be read. Do not pick it for work.
3. Put batches whose `repoUrls` match this repo's git remote (compare host + owner/repo, ignore `.git` and protocol) first. Mark them "this repo". If the remote is missing, mark none.
4. If there are no waiting or in-progress batches, say so, and say where exports are read from (`<Downloads>/prototype-feedback/inbox/` and `prototype-feedback_*.zip` in Downloads). Stop.
5. Ask the user which batch to work on. Default to the newest matching one.

## 2. Open it
1. Call `batch_open` with the id. It unpacks the batch to `<dir>` and archives the ZIP.
2. Skip comments that already have a final status in the returned `status` map (fixed, answered, proposed, needs_input, skipped).
3. If `version_hints` pins a commit and it is in this repo's history, run `git rev-list --count <commit>..HEAD` and say how many commits the code moved since the reviewed version. Flag comments whose page maps to files changed since then (`git diff --name-only <commit>..HEAD`).

## 3. Plan, then wait
1. Group comments by page, urgent first. For each, one line: verb, the reviewer's text (or "(no text — infer from screenshot)"), and what you intend to do.
2. Read each comment's `screenshot_path` and `viewport_screenshot_path` (relative to `<dir>`) with the Read tool before planning it. Use `selector` and `element_snapshot` to find the element in the code.
3. Show the plan and wait for the user's OK. Do not edit anything before that.

## 4. Branch
1. If the opened batch already has `fixed` statuses, look for an existing branch that holds those commits: run `git branch --list "feedback/*"`, then `git log --oneline -1 <branch>` for each candidate. Ask the user whether to continue on that branch. Do not start a fresh branch from HEAD without asking.
2. Otherwise, create and check out a branch `feedback/<site>-<YYYY-MM-DD>` from HEAD (`<site>` = the first comment's page host without `www.`, dots → dashes; date in ET). If it exists, add `-2`, `-3`, …

## 5. Work each comment
Per verb:
- **fix** — something is wrong; decide how to make it right. A thin or empty comment is fine: infer from the screenshot, DOM snapshot and console log. Make the change, then make **one commit per comment** (message: `feedback: <short summary>`). Run `git rev-parse HEAD` right after the commit to get `commit_sha`. Then `status_set` with `status: "fixed"`, `commit_sha`, `summary` (≤120 chars), `files_changed`.
- If a fix produces no diff, do not make an empty commit. `status_set` with `status: "skipped"` and the reason in `summary`.
- If a commit fails (for example, a hook rejects it), do not record `fixed`. Tell the user the error and stop on that comment.
- **change** — it works but should be different as described. Same as fix.
- **ask** — answer the question from the code; no code changes. `status_set` with `status: "answered"` and `answer`.
- **idea** — no code. Write a short proposal and `status_set` with `status: "proposed"` and `proposal: {approach, effort: "S"|"M"|"L", risk}`.
- If you cannot tell what the reviewer wants, or it needs a product decision, do not guess: `status_set` with `status: "needs_input"` and one-sentence `question_back`.
- If it is out of scope or impossible, `status_set` with `status: "skipped"` and the reason in `summary`.

Call `status_set` right after each comment, not at the end, so status reaches the extension while you work. If `status_set` returns an error, show it and stop.

## 6. Finish
1. Summarise: per comment, its status and one line. List the branch name and commits.
2. Tell the user how the reviewer sees the result:
   - Extension 0.7.0+ with Claude Code open: the pins update on their own.
   - Extension 0.6.0: open the extension popup → **Import status** (Import resolutions) and pick `<dir>/responses.json`.
3. Do not merge the branch; merging is the user's call.
