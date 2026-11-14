# The GitHub token

## What it is

The token is a GitHub personal access token that the PM pastes in. It is the app's only
credential. There is no app registration, no OAuth flow, and no backend holding tokens.

**Minimum access needed:**
- **Fine-grained token**, limited to the three repos:
  - Contents: read and write;
  - Pull requests: read and write;
  - Metadata: read.
- **Or a classic token** with the `repo` scope.

The sign-in screen explains this.

## Where it lives

- **Encrypted at rest.** It is encrypted with Electron `safeStorage`, which on macOS uses a key
  held in the user's login Keychain. The ciphertext is written to `token.bin` in the app's data
  folder (see [local-data.md](local-data.md)). Code: `src/main/app/secrets.ts`.
- **Never in plain text.** If encryption is unavailable, the app refuses to save the token rather
  than writing plain text (`SecureStorageUnavailable`; `test/secrets.test.ts`).
- **Environment override.** A `GITHUB_TOKEN` variable, if set, takes precedence and is never
  written to disk.
- **Sign-out** deletes `token.bin`.

## Which process can read it

**Only the main process.** The window (renderer) is sandboxed and context-isolated, and reaches
the main process only through the preload bridge in `src/preload/index.ts`.
- No bridge call returns the token. `getAuth` returns the host, the login and whether the token
  came from the environment or the Keychain.
- `signIn` sends a token *into* the main process; nothing sends one back out.
- The smoke test asserts the bridge exposes exactly the intended methods.

## Where it is sent

**Only to the configured GitHub host**, as the `Authorization` header Octokit adds to each request.
Every request first passes the host allow-list (see [network.md](network.md)).

## Never in logs or on disk in plain text

The Phase 5 end-to-end check:
1. signed in through the UI;
2. went through onboarding, linking, the board and the metrics view;
3. relaunched, which resumed the session from the Keychain;
4. then scanned **every file in the data folder** and **every line of main-process and window log
   output** for the token string.

Result: **0 files, 0 log lines**.

## Expiry and revocation

If GitHub answers `401` for the session's token mid-session:
- the app signs out at once and deletes the stored token;
- it shows "Sign in again" with the reason;
- it keeps every product, link, cached state and setting.

A `401` while *validating a new token*, in "Change token", does not end the working session
(`test/resilience.test.ts`). If GitHub can't be reached at all at launch, the session stays
signed in but marked offline instead of discarding a token that may still be valid.
