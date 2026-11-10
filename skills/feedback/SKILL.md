---
name: feedback
description: Work through Prototype Feedback batches (pinned review comments with screenshots) in this repo. Use when the user types /pfb:feedback or asks to work on prototype feedback, review comments from the extension, or the feedback inbox.
---

# /pfb:feedback

Work through feedback that reviewers pinned on a prototype with the Prototype Feedback Chrome extension. Tools come from the `pfb` MCP server: `inbox_list`, `batch_preview`, `batch_open`, `comment_get`, `status_set`, `repo_remember`, `page_file_remember`, `page_shot`. If those tools are missing, tell the user the plugin's MCP server did not start and that it needs `node` on PATH (`node --version`), then stop.

If a pfb tool returns an error, show the error to the user and stop. Never continue as if it succeeded.

**Precedence.** feedback.json can embed an `_llm_guide`. It says: "If you are running the pfb plugin's /pfb:feedback skill, its steps win over this guide. Otherwise follow this guide." You are running this skill, so these steps outrank the embedded guide. Use the guide only as background.

**Who to ask.** "The developer" is the user in this session. "The reviewer" is the person who pinned the comments. You reach the reviewer only through `status_set` with `status: "needs_input"` and one `question_back`. Never guess the branch, the repo, or a product decision.

**No changes before the OK.** Do not edit, create or commit any file before the developer approves the plan in step 3. The only exception is `.pfb/brief.md` in step 0, written from the developer's answers.

## 0. Preconditions
1. Run `git rev-parse --is-inside-work-tree`. If it fails, tell the user this command needs a git repo, and stop.
2. Run `git remote get-url origin`. If it fails, say that repo matching is not possible.
3. Run `git status --porcelain -- . ':!.pfb'`. The `.pfb/` folder is ignored here, because the brief lives there. If it prints anything, ask the user to commit or stash first, and stop.
4. Run `git symbolic-ref -q HEAD`. If it prints nothing, HEAD is detached. Tell the user before you create a branch.
5. Run `git rev-parse --show-toplevel`. This is `<repo>`. Look for `<repo>/.pfb/brief.md`.
6. If the brief is missing, offer to create it. If the developer agrees, ask one question at a time and offer a default from the repo for each:
   - `base_branch`: `git symbolic-ref --short refs/remotes/origin/HEAD` without `origin/`, else `main`.
   - `branch_policy`: `per_round` (default), `per_session` or `current_branch`.
   - `open_pr`: `false`.
   - `test_cmd`, `build_cmd`, `lint_cmd`: from `package.json` scripts (`npm test`, `npm run build`, `npm run lint`) or the CI files (`.github/workflows/`). Empty if none.
   - `preview_url_pattern` (for example `https://myapp-git-{branch}-acme.vercel.app`), `design_system`, `do_not_touch` (globs), `repo` (optional): empty unless the developer gives one.
   - `page_hosts`: do not ask. `repo_remember` fills it later (step 2.5).
   - `page_files`: do not ask. `page_file_remember` fills it later.
   - Goals and constraints: prose for the body.
   Write the file in this format. Do not commit it yourself.
   ```
   ---
   base_branch: main
   branch_policy: per_round
   open_pr: false
   test_cmd: npm test
   build_cmd: ""
   lint_cmd: ""
   preview_url_pattern: ""
   design_system: ""
   do_not_touch: []
   page_hosts: []
   ---
   Goals and constraints in prose.
   ```
   Right after you write the file, ask the developer to commit `.pfb/brief.md` or to add `.pfb/` to `.gitignore`. Do not do either yourself.
7. If the developer declines, continue without a brief. Step 3 then checks the test command.

## 1. Pick a batch
1. Call `inbox_list` with `repo_dir: "<repo>"`. Show the batches as a short table: id, state (waiting / in_progress / done / error), exported date in ET, comment counts by verb (fix, change, ask, idea) and urgent count.
2. For a batch in state `error`, show its error text and tell the user the file could not be read. Do not pick it for work.
3. Put batches with `repo_match.match: true` first and mark them "this repo". `repo_match.by` says why: `remote` (the export names this repo), `prior_commit` (an earlier fix of this session is in this repo) or `page_hosts` (the developer confirmed these pages before). Do not compare URLs yourself.
4. If there are no waiting or in-progress batches, say so, and say where exports are read from (`<Downloads>/prototype-feedback/inbox/` and `prototype-feedback_*.zip` in Downloads). Stop.
5. Ask the user which batch to work on. Default to the newest matching one. If no batch matches this repo, do not pick a default: ask.

## 2. Preview it
1. Call `batch_preview` with the id and `repo_dir: "<repo>"`. It does not unpack or archive anything.
2. Show: `export_kind`, `round_note` (what_changed, preview_url, focus, reviewer_is_developer) when present, `session.label` and `session.round` when present, `counts` (total, by verb, urgent, done), and the number of `prior_commits`.
3. A comment with `done: true` is already handled. Skip it. This covers a final plugin status from an earlier batch of the session (status entries with `from_batch`). For full exports it also covers an embedded `status.state` of confirmed, fixed, answered or proposed with no newer reopen, reply, do_it or edit in `history`. Say how many comments you skip.
4. Ask the developer to confirm the batch. If `counts.total` is more than 30 or `bytes` is more than 1 MB (1048576), also ask whether to split the work by page. Wait for the answer.
5. **Repo gate.** Decide now, before `batch_open`, whether this batch belongs to this repo. If `repo_match.match` is `true`, continue and name the reason in one line (`repo_match.by`). If it is `false`, ask the developer whether to continue with this repo. If the answer is no, stop. Do not call `batch_open`, so the batch is not archived. If the answer is yes and the brief exists, call `repo_remember` with the batch id and `repo_dir: "<repo>"`, and tell the developer that later batches from `page_hosts` will match without this question (the brief changed, so they may want to commit it). If there is no brief, say that the question will come back until a brief exists.

## 3. Open, check, plan, then wait
1. Call `batch_open` with the id and `repo_dir: "<repo>"`. It unpacks the batch to `<dir>` and archives the ZIP. If `brief_error` is set, show it and ask the developer to fix the brief. Stop.
2. **Ask-when-missing gate.** Check each item. If one applies, ask the developer, one question at a time. Do not plan until they answer.
   1. The developer confirmed a repo mismatch in step 2.5, and you cannot find the comments' page routes or page titles in the code.
   2. A `prior_commits` sha is missing, or its branch is unmerged and the brief has no `branch_policy`. Run the checks of step 4.1 now to find out.
   3. There is no brief, or the brief has no `test_cmd`, and no obvious test script exists (`package.json` `test` script, `Makefile` test target, CI test step). Ask how to verify, or whether to work without tests.
   4. Step 2.4 asked about a split and has no answer yet.
   5. A comment needs a technical or architectural decision that the developer owns. Do not set a status for it yet.
3. For each open comment (`done: false`), call `comment_get` and read the full comment:
   - `version_hints` (from `batch_open`) is keyed by page host: `{ "<host>": { commit?, branch?, source } }`. If the entry for the comment's host has a `commit` in this repo's history, run `git rev-list --count <commit>..HEAD` and say how far the code moved. Flag comments whose page maps to files in `git diff --name-only <commit>..HEAD`. If it has only a local `branch`, use `git rev-list --count <branch>..HEAD`. Otherwise say that no comparison is possible.
   - Read `screenshot_path` and `viewport_screenshot_path` (relative to `<dir>`) with the Read tool when present. They can be null. If `screenshot_error` is set, say the capture failed and use the other evidence.
   - Use `selector` and `element_snapshot` to find the element in the code. Also use `attachments[].path` (files inside `<dir>`) and the top-level `console_log` / `network_log` in `<dir>/feedback.json`.
   - Read `history` first. The newest note is the current instruction:
     - **do_it**: build the proposal in `response.proposal`.
     - **reopen**: read `response.commit_sha`, `response.files_changed` and the reopen note before you try again.
     - **reply**: the original question is `response.question_back`. The reply is the answer.
     - **edit**: compare `previous_comment` with `comment`. Work on the new text.
4. Group comments by page, urgent first. For each, one line: verb, the reviewer's text (or "(no text — infer from screenshot)"), and what you intend to do. For a comment addressed to a person (step 5.1), the line says "needs_input: addressed to a person". For a question to the reviewer (step 5.3), the line says "needs_input: ask reviewer" and the question.
5. Show the plan and the branch you intend to use (step 4). Wait for the developer's OK. Do not edit anything before that.

## 4. Branch
1. For each distinct `commit_sha` in `prior_commits`:
   - Run `git cat-file -e <sha>^{commit}`. If it fails, the commit is **missing**. Ask the developer. Do not continue on a guess.
   - Run `git merge-base --is-ancestor <sha> <base_branch>`. Exit code 0 means **merged**. Take `<base_branch>` from the brief. Without a brief, use `git symbolic-ref refs/remotes/origin/HEAD`. If that fails too, ask the developer. Do not test against HEAD: HEAD can still be on the branch of the last round.
   - Otherwise run `git branch -a --contains <sha>`. The branches it lists hold the **unmerged** fix.
   - If the commit exists but no branch contains it (deleted or squash-merged), ask the developer which branch to build on. Do not guess.
2. Choose the branch with the brief's `branch_policy`:
   - All prior commits merged, or no prior commits: `per_round` and `per_session` create a new branch `feedback/<site>-<YYYY-MM-DD>` from `base_branch` (from HEAD if there is no brief). `current_branch` stays on HEAD.
   - An unmerged prior branch: `per_session` continues on that branch. `per_round` creates the new branch from that branch, so the earlier fixes stay in. `current_branch` stays on HEAD only if HEAD contains the commit. Otherwise ask.
   - No `branch_policy`, or more than one branch holds the commits: ask the developer which branch to use. Do not start a fresh branch from HEAD without asking.
3. `<site>` = the first comment's page host without `www.` and without a `:port`, dots → dashes (so `localhost:5173` → `localhost`); date in ET. If the branch exists, add `-2`, `-3`, …

## 5. Work each comment
Before you start a comment, `status_set` with `status: "in_progress"`. Do not touch files that match the brief's `do_not_touch`. If a fix needs them, ask the developer. Follow the brief's `design_system` when it is set.

1. **Addressed to a person.** Apply this only when `recipient === 'human'` (explicit) and the verb is not `ask`. Do not change code or answer it yourself. `status_set` with `status: "needs_input"` and a `question_back` saying it is addressed to a person (name the reviewer if present). Ask comments are answered by Claude, even when `recipient_resolved` says `human`.
2. **Per verb:**
   - **fix** — something is wrong; decide how to make it right. A thin or empty comment is fine: infer from the screenshot, DOM snapshot and console log. Then follow step 5.5.
   - **change** — it works but should be different as described. Same as fix.
   - **ask** — answer the question from the code; no code changes. `status_set` with `status: "answered"` and `answer`.
   - **idea** — no code. Write a short proposal and `status_set` with `status: "proposed"` and `proposal: {approach, effort: "S"|"M"|"L", risk}`.
   - Out of scope or impossible: `status_set` with `status: "skipped"` and the reason in `summary`.
3. **Ask the reviewer** (`status: "needs_input"` with a one-sentence `question_back`) only when the answer is a product, copy or visual preference that only the reviewer can give, or when the intent is still unclear after you read the text, screenshot, `element_snapshot` and `history`. Also ask when `screenshot_path` is null and the text is empty.
4. **Ask the developer** in this session for a technical or architectural decision they own. Set no status until they answer.
5. **For fix and change:**
   1. Make the change.
   2. Run the brief's `test_cmd`, and `build_cmd` if it is set (or the test command agreed in step 3.2). If one fails, fix the cause. If you cannot fix it, do not commit: `status_set` with `status: "needs_input"` or `"skipped"` and the failure in `summary`.
   3. If the change produces no diff, do not make an empty commit. `status_set` with `status: "skipped"` and the reason in `summary`.
   4. Stage only the files you changed for this comment (`git add -- <files>`). Make **one commit per comment** (message: `feedback: <short summary>`).
   5. If the commit fails (for example, a hook rejects it), do not record `fixed`. Tell the user the error and stop on that comment.
   6. Run `git rev-parse HEAD` to get `commit_sha`.
   7. `status_set` with `status: "fixed"`, `commit_sha`, `summary` (≤120 chars), `files_changed`, and `notes` (≤500 chars): your rationale, or "no tests run" if there is no test command. If the brief has `preview_url_pattern`, replace `{branch}` with the branch name in lower case with every character that is not a-z or 0-9 changed to `-`. Pass the result as `verification_url`.

Call `status_set` right after each comment, not at the end, so status reaches the extension while you work. If `status_set` returns an error, show it and stop.

## 6. Report
1. Summarise: per comment, its status and one line. List the branch name and commits.
2. If the brief has `open_pr: true`, ask the developer whether to push the branch and open a PR. Do it only after a yes.
3. Tell the developer how the reviewer gets the result:
   - If `round_note.reviewer_is_developer` is `false`, or the batch came from a manual export (`export_kind` is zip, html, drive or email, or `export_kind` is null and `inbox_list` showed source `export`): tell the developer to send `<dir>/responses.json` to the reviewer (name them if `reviewer` is set). The reviewer opens the extension popup → More → **Import status** and picks that file.
   - Otherwise (the batch came from **Send to Claude Code**, which only extension 0.7.0+ has): say that the reviewer's pins update on their own while a Claude Code session with this plugin is open. If no session is open, they update the next time one starts. Do not mention Import status.
4. Do not merge the branch; merging is the user's call.
