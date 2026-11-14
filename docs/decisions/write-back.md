# Write-back: one engine, branch plus pull request, never the default branch

Phase 4a, per the PM Workbench plan (Technical approach → Write-back; Phase 4). **Flagged for
human review before merge**: this is the first code that writes to the shared repos.

## Decided before this phase

- Every write is a branch plus a pull request. Direct commits were rejected, even for small notes.
- New artifacts start from templates in the shared artifacts repo. Their location is not
  hard-coded, and no template files are added to the repo.
- Review and approval stay in GitHub. The app has no approval flow of its own.

## The flow (`src/main/write/engine.ts`)

1. **Preview.** The main process reads what is there now:
   - the base head;
   - the file on the branch the commit will sit on, plus its blob SHA;
   - whether the destination already exists;
   - whether an open app pull request already touches the file.

   It then works out the branch name, a unified diff, the commit message, and the pull request's
   title and body. That plan is held in the main process under a random, single-use id that
   expires after 10 minutes. **Nothing is sent to GitHub at this step.**

2. **The PM reviews** the repo, branch, base, commit, every file's diff and the pull request
   description, then confirms.

3. **Confirm** takes only the id, so the window can't change what is sent after seeing it.
   - **Stale check.** The branch being built on is re-read. If any target file's blob SHA differs
     from the preview, or the app's existing PR branch moved, nothing is sent and the PM is asked
     to preview again.
   - **One commit.** It contains every file. It is built from a tree on top of the current head
     (`POST git/trees`, then `POST git/commits`), so it is a single commit even when several files
     change.
   - **New change:** create the branch at that commit (`POST git/refs`), then open the pull request.
   - **The app's open pull request already touches the file:** fast-forward that branch to the
     commit (`PATCH git/refs`, never forced). No second pull request is opened.
   - **Cleanup.** If anything fails after the branch was created, the branch is deleted again.
     The commit object is created before the branch, so a failure there leaves nothing at all.
   - **Bookkeeping.** Every branch and pull request the app opened is recorded locally in the
     `writes` table. That is how "an open pull request from the app already touches that file" is
     detected, and what Phase 4b's "my open pull requests" view will list.

## The default-branch guard: two layers

**1. Engine layer.** Before confirming, `assertWritableBranch` refuses to write unless:
- the branch is under `pmworkbench/`;
- it is not the repo's default branch, nor `main`, `master`, `develop` or `trunk`;
- it is not the pull request's base.

**2. Network layer** (`src/main/write/guard.ts`). Every request the GitHub client sends passes this
before the host allow-list. Reads pass. A write is let through only if it is one of:

| Request | Allowed when |
|---|---|
| `POST git/trees`, `POST git/commits`, `POST git/blobs` | Always. These only create objects; nothing changes until a ref points at them. |
| `POST git/refs` | The ref is `refs/heads/pmworkbench/…` and not a protected name. |
| `PATCH git/refs/heads/…` | It is an app branch, and not forced. |
| `DELETE git/refs/heads/…` | It is an app branch. |
| `POST pulls` | The head is an app branch. |

Everything else is refused before it leaves the process, including the contents API, merges,
`PUT pulls/{n}/merge`, tags and force-pushes. That holds even if the engine has a bug: a test calls
the client directly with `main` and checks that no request is sent.

## Branch naming

`pmworkbench/<type>/<title-slug>-<yyyymmdd>` for a new artifact, and
`pmworkbench/edit/<file-slug>-<yyyymmdd>` for an edit. If the name is taken, `-2`, `-3`, … is
added at preview time.

## Templates

**Settings → Artifact templates** holds one file path per artifact type in the artifacts repo.
Saving checks that the file exists. `{{title}}`, `{{product}}` and `{{date}}` are filled in. A type
with no template starts blank. The paths are stored locally only. The test repo has no templates
folder, so the end-to-end run used the existing control book as the control-book template.

## A new item is pending until it merges

A created artifact is linked to its product straight away:
- in the stage suggested for its type (overridable in the form);
- with `pending = { prNumber, branch }`.

The sync treats a pending link by its pull request:
- **open:** the card shows "Pending · PR #n <status>", and the preview reads the file from the branch;
- **merged:** the pending flag is cleared and the link becomes an ordinary file link, checked as one
  in the same sync;
- **closed without merging:** the link is marked broken.

This covers Phase 4b's "convert the pending link on merge" ahead of time, because without it a new
artifact would show as broken until it merged.

## Failure cases

| Case | What happens |
|---|---|
| Destination already exists on the base | Refused at preview. |
| An app pull request already adds the same new path | Refused at preview, pointing at that PR. |
| File changed on the base (or the PR branch moved) since the preview | Refused at confirm. Nothing is written. |
| Branch name taken between preview and confirm | "A branch named … already exists. Preview again." No branch or PR is created. |
| No write permission (403/404) | "Your token can't write to … It needs read and write access to contents and pull requests." No branch. |
| Protected-branch or status-check rejection (422) | Explained as a branch protection rule. |
| Pull request can't be opened | The new branch is deleted, and no link or write record is kept. |
| A preview id used twice, or expired | Refused. |

## Verified against `gonzalovazquez/pm-artifacts`

- **Main never moved.** It was at `6f42999` before and after.
- **Six pull requests, all from `pmworkbench/…` into `main`:**
  - #1 control book, created through the UI from its template;
  - #2 problem brief;
  - #3 solution brief;
  - #5 specification;
  - #6 executive communication;
  - #4 an edit of the linked control book, made through the UI. A second edit was added to #4 as a
    second commit instead of opening another pull request.
- Creating over `README.md` was refused before anything was sent.
- New artifacts showed as pending, with their PR status, on the board.

These PRs are left open for review. Close them and delete their branches when done:
`gh pr list -R gonzalovazquez/pm-artifacts --json number --jq '.[].number' | xargs -n1 gh pr close -R gonzalovazquez/pm-artifacts --delete-branch`.

**Not explained:** in the first end-to-end run, the app window closed during a run of bridge calls,
right after #2 was opened. Nothing was left half-done. Two more runs with main-process logging, one
repeating that run's exact sequence, did not reproduce it.

---

# Phase 4b: CRM conversations, PDRs, approval status

**Also flagged for human review before merge**, since it extends writes to the CRM and PDR repos.
Everything goes through the same engine, preview and guards as above.

## CRM conversations

- **Layout is read from the repo** (`detectCrmLayout`): the folder whose Markdown files most often
  carry dated `## YYYY-MM-DD — topic` sections, the customers in it (each file's `# Name`), and the
  heading separator they use.
  - In the test repo that's `customers/`, with ` — `.
  - Nothing is hard-coded, and the PM can type another path for a new customer.
- **Logging** appends a `## <date> — <topic>` section to the customer's file, with a participants
  line and the notes, in the repo's own style. A new customer gets a new file starting `# <Name>`.
- **Through the engine.** If an app pull request is already open on that customer's file, the
  conversation is added to it as a commit; otherwise a `pmworkbench/crm/<customer>-<date>` branch
  and pull request are opened.
- **Linking.** The conversation (and, for a new customer, the customer) is linked to the product,
  pending, in **intake and triage** by default. Its anchor is computed from the new content, so it
  resolves once merged.

## PDRs and the repo's branch convention

- **Layout** (`detectPdrLayout`): the folder with the most records, and a `<prefix>-<NNN>-` naming
  pattern if there is one. A new record continues the sequence: `specs/spec-004-….md` after
  `spec-003`. A title that already carries the number isn't repeated in the file name.
- **Template.** It uses a `*template*.md` file found in the PDR repo. If there is none, it offers a
  minimal structure (status, owner, reviewers, problem, options, decision, consequences) that the
  PM sees and edits before sending.
- **Convention** (`suggestConvention`):
  - **Base:** the most common base of existing pull requests. With no pull requests, a `develop`
    branch means git-flow, so the base is `develop`; otherwise the default branch.
  - **Prefix:** the most common `prefix/` among branches and pull-request heads. With no history,
    it comes from the records folder (`specs` → `spec/`).
  - **Confirmed once.** The PM confirms or edits both the first time. The choice is saved per repo
    (`settings.json` → `branchConventions`) and reused, and can be changed later.
  - **Test repo:** "a develop branch exists (git-flow); no branch history, so spec/ from the specs
    folder".
- **The pull request** goes from `<prefix><file-stem>` (for example `spec/spec-004-retry-limits`)
  into the confirmed base. Nothing is written to `develop` or `main`.

## Guard changes for conventions

The network write guard and the engine's `assertWritableBranch` now have two modes.

| Mode | Allowed when |
|---|---|
| **create** (`POST git/refs`) | The branch is under `pmworkbench/` **or** under a prefix the PM confirmed for that repo. |
| **modify** (fast-forward, delete, or the head of a new pull request) | The branch is under `pmworkbench/` **or** is one the app itself created (in its `writes` record). |

So a confirmed prefix like `spec/` lets the app *create* `spec/…` branches, but never move or
delete someone else's `spec/…` branch. Protected names (`main`, `master`, `develop`, `trunk`, the
repo's default) are refused in both modes, and a prefix can't be one of them or `refs/`.

**GraphQL.** It is allowed only for read-only queries (no `mutation` or `subscription`), and only
to read review-thread resolution, which GitHub's REST API doesn't expose.

## Approval status

- **What's shown.** For every PDR linked as a pull request, or pending in one: state (draft, open,
  changes requested, approved, merged, closed), each reviewer's latest decisive review (or
  "waiting"), and the **unresolved review-comment count**.
- **Where:**
  - an **Approval status** panel under Decisions on the product home, with "Review on GitHub";
  - the board card;
  - the new **Pull requests** page.
- **Cost of the count.** It is one GraphQL read, made only when the pull request's `updated_at`
  changed since the last sync, so unchanged pull requests cost nothing extra.
  - **Limitation:** resolving a thread may not change `updated_at`. The count catches up on the
    pull request's next change.
- **Git-flow merges.** A PDR merged into `develop` stays **pending (merged)** until the file
  reaches the default branch in a release. It isn't shown as broken in the meantime.

## "My open pull requests"

The **Pull requests** page (sidebar → App) lists every pull request the app opened, across the
three repos. For each it shows the product, status, reviewers, unresolved comments and age, and
links to GitHub. Open ones show by default, with merged and closed ones available. It reads through
the same cached, conditional sync and back-off as the board.

## Verified against the test repos

- **CRM (`pm-crm`):**
  - **#1** `pmworkbench/crm/acme-corp-20261114` → `main` logged an Acme conversation through the UI;
  - a second conversation was added to #1 as its second commit.
- **PDR (`pm-pdr`):**
  - **#1** `spec/spec-004-spec-004-e2e-retry-limits` → `develop`, raised through the UI after
    confirming `spec/` → `develop`. (This run produced the doubled number in the name, which has
    since been fixed.)
  - A review comment left on it showed as **1 unresolved comment** in the approval panel and on the
    Pull requests page.
- **Base branches unchanged:** `pm-crm` `main` `ec80a6f`, `pm-pdr` `main` `16c4df0`, `pm-pdr`
  `develop` `94a81ee`.
- **Review states with a second account weren't possible.** GitHub doesn't let you approve your
  own pull request, so each state (changes requested, approved, re-requested, merged into develop,
  then released) is covered with the fake GitHub in `test/crm-pdr.test.ts`.
