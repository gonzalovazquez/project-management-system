# GitHub access: API vs. local clones

Phase 1 spike, per the PM Workbench plan (Technical approach → GitHub access and sync).

## Question

Talk to the three repos through the GitHub REST API (Octokit), or clone them locally and drive
git — for browsing today, and for creating branches, commits and pull requests in Phase 4.

## What was checked

Octokit (`@octokit/rest`) against the REST endpoints this app needs:

- `GET /user` — validate a token and learn who it belongs to.
- `GET /user/repos` — list repos the token can see, for repo-role setup.
- `GET /repos/{owner}/{repo}/contents/{path}` — list a folder, or read a file's content
  (base64 up to ~1MB; larger files need `GET .../git/blobs/{sha}`, handled in `client.ts`).
- Needed in Phase 4, not yet used here, and confirmed to exist on the same API surface:
  `POST /repos/{owner}/{repo}/git/refs` (branch creation), `PUT /repos/{owner}/{repo}/contents/{path}`
  (file commit), `POST /repos/{owner}/{repo}/pulls` (pull request), and the pull-request review
  endpoints Phase 4b's approval status needs.
- `baseUrl` differs by host: `https://api.github.com` for github.com, or
  `https://<host>/api/v3` for a GitHub Enterprise Server instance (see `host.ts`). Enterprise
  Cloud uses the same `api.github.com` base as github.com. Which of these the company's GitHub is
  — Cloud or Server — is still open; the host setting and `apiBaseUrl` cover either without
  knowing yet.

## Decision

The API, through Octokit, with a local cache (Phase 3a) so the app opens quickly and still shows
the last known state when offline or rate-limited.

## Why over local clones

Local clones would put repo contents and git credentials on disk, which is harder to defend in a
security review, and branch/merge handling would have to be rebuilt inside the app rather than
using GitHub's own pull-request endpoints. The API route needs no git binary, no working tree on
disk, and gives branches, commits and pull requests as single authenticated calls — which is also
what every request in Phase 4's write engine needs to pass through the network allow-list cleanly
(one fetch implementation to guard, not a shelled-out git process).

## Consequences

- Every GitHub call in the app goes through `createGitHubClient`, whose `fetch` is wrapped by
  `createGuardedFetch` (`allowlist.ts`) — nothing reaches a host other than the one configured at
  sign-in.
- Rate limits are a real constraint for the workflow board (Phase 3a) and flow metrics (Phase 3b):
  both need caching and conditional requests, not a call per linked item on every refresh.
- Fine-grained vs. classic personal access tokens: not yet confirmed which the company's GitHub
  Enterprise allows. Both work the same way against the endpoints above, so nothing here depends
  on the answer; the minimum scopes are read/write on repository contents and pull requests.
