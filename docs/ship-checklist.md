# Ship criteria: results (Phase 5, 14 November 2026)

These are the ten items in the Planning section of the PM Workbench plan, run end to end:

- **Against:** the test repos `gonzalovazquez/pm-{artifacts,crm,pdr}`.
- **App:** the source build (`npm run build`), with a **fresh, empty data folder and no
  `GITHUB_TOKEN` in the environment**. Sign-in went through the UI, then the first-run onboarding.
- **Packaged build:** checked separately (item 9).
- **Not done:** the plan asks for a *clean macOS user account*. That needs an admin action on this
  Mac, so a fresh data folder stood in for it.

**Summary: 8 met, 0 partly met, 1 not met, 1 met on one Mac.** Updated after Phase 4b. The
remaining gap is Developer ID signing and notarization credentials, which aren't available.

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | A PM can sign in with a personal access token against the company GitHub host; the token is in the macOS Keychain and appears nowhere in plaintext on disk or in logs. | **Met** (github.com) | Signed in through the UI, and the session resumed from the Keychain after a relaunch. A scan of every file in the data folder and every log line found the token **0 times**. The company host itself is untested, because it isn't known yet whether it's Enterprise Cloud or Server; the host setting handles either. See `docs/security/token.md`. |
| 2 | The PM can assign the three repos their roles and browse each one from the app. | **Met** | Onboarding pre-selected `pm-artifacts`, `pm-crm` and `pm-pdr` for the right roles from their names. Each one browsed correctly. This run found and fixed a bug where switching repos briefly showed the previous repo's files. |
| 3 | The PM can create a product with an objective and link at least one artifact, one customer conversation and one PDR to it, and the product home shows all of them together with the objective. | **Met** | Created during onboarding. The link picker linked the control book, the Acme 2026-09-18 conversation and SPEC-003 in one step. The home showed Customers, Artifacts and Decisions under the objective. |
| 4 | The workflow board shows every linked item in exactly one of the five stages, with its current GitHub state. | **Met** | The conversation landed in Intake and SPEC-003 in Specification, both suggested at link time. The control book (no suggestion) was in the Unstaged tray. Every card showed "On default branch". Exactly-one placement is also covered by `test/board.test.ts`. |
| 5 | A problem brief, a control book, an executive communication, a CRM conversation and a PDR can each be created from the app, and each lands as a pull request in the correct repo; nothing is committed directly to a default branch. | **Met** | Artifacts (Phase 4a): PRs #2, #1 and #6 in `pm-artifacts`; `main` stayed at `6f42999`. CRM conversation (Phase 4b): `pm-crm` #1 into `main`. PDR (Phase 4b): `pm-pdr` #1 from `spec/…` into `develop`. `pm-crm` `main`, `pm-pdr` `main` and `pm-pdr` `develop` didn't move. |
| 6 | A PDR's review and approval state is visible in the app without opening GitHub. | **Met** | The product home's Approval status panel, the board card and the Pull requests page show state, reviewers with their latest review, and unresolved comments. Against real GitHub, a comment on `pm-pdr` #1 showed as "1 unresolved comment". The changes-requested and approved states need a second reviewer account, so they're covered with mocks (`test/crm-pdr.test.ts`). |
| 7 | A product's mapping exported on one Mac imports on another and produces the same product home. | **Met (one Mac)** | `test/product-service.test.ts` exports, wipes the database, imports into a fresh one, and asserts an identical product home, stages included. It also reports unmatched repos instead of failing. Not tried on two physical Macs. |
| 8 | The app makes no network calls other than to the configured GitHub host, and still opens and shows the last synced state when offline or rate limited. | **Met** | Network: the allow-list tests; the renderer `fetch` refusal in `npm run smoke`; and a sync with every request blocked, which sends zero requests and still renders from cache. Offline and rate limits: `test/resilience.test.ts` covers the browser and previews from cache, a rate-limit back-off that sends nothing until the reset time, and an offline launch that stays signed in. **Not tried with the Mac's network physically off.** |
| 9 | A signed, notarized build installs on a managed Mac and a teammate completes setup without help. | **Not met** | There are no Developer ID or notarization credentials on this Mac (only an Apple *Development* certificate, which can't be notarized). The pipeline is ready (`docs/release.md`). An **unsigned** universal build was produced (`PM Workbench-0.1.0-universal.dmg`, 231 MB (530 MB installed); `x86_64 arm64`; hardened runtime; fuses verified), and its packaged binary passed the smoke checks. Onboarding exists (sign-in → repos → templates → first product), but it wasn't tried by a teammate on a managed Mac. |
| 10 | A product's metrics view shows items by stage over time, time in stage, activity per week across the three repos, stall flags and a health score, each with a table view. | **Met** | All five charts rendered for the onboarded product, each with "View as table", plus the stall-flags list (Phase 3b; light and dark checked then). |

## Before rollout
1. Get a Developer ID Application certificate and notarization credentials, then run
   `npm run package` with them (item 9).
2. Repeat this run on a clean macOS user account on a managed Mac, against the company GitHub
   host, with a teammate doing onboarding unaided.
