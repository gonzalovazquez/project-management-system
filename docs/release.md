# Building and releasing PM Workbench

```
npm install
npm run package     # = npm run build && node scripts/package.mjs
```

**What it produces:** one **universal** app (Apple silicon and Intel), as
`release/PM Workbench-<version>-universal.dmg` and `…-universal-mac.zip`. Each is about **231 MB** (530 MB once installed),
because a universal build carries both architectures. A build takes about a minute on an M-series
Mac once Electron is cached.

## Signing and notarization

These are configured **only through environment variables**; no credential lives in the repo.

| Purpose | Variables |
|---|---|
| Developer ID signing | `CSC_LINK` (path to, or base64 of, the `.p12`) and `CSC_KEY_PASSWORD`, **or** `CSC_NAME` set to a `Developer ID Application: …` identity in the keychain |
| Notarization (App Store Connect API key, preferred) | `APPLE_API_KEY` (path to the `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` |
| Notarization (Apple ID) | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |

**With signing variables set**, the app is signed with Developer ID under the hardened runtime,
using `build/entitlements.mac.plist` (JIT only). With notarization variables set as well, it is
notarized and stapled.

**With no signing variables**, it builds an **unsigned** test version: an ad-hoc signature plus
the test-only `build/entitlements.adhoc.plist`. That version runs on the Mac that built it, but
Gatekeeper blocks it elsewhere.

An Apple *Development* certificate is deliberately never used. Builds signed with one can't be
notarized and won't run on teammates' Macs.

## Verifying a build

```
codesign -dv --verbose=2 "release/mac-universal/PM Workbench.app"     # Authority=Developer ID Application…, flags=runtime
spctl -a -vv "release/mac-universal/PM Workbench.app"                 # accepted, source=Notarized Developer ID
xcrun stapler validate "release/PM Workbench-<version>-universal.dmg"
npx @electron/fuses read --app "release/mac-universal/PM Workbench.app"
lipo -archs "release/mac-universal/PM Workbench.app/Contents/MacOS/PM Workbench"   # x86_64 arm64
```

## Installing

Open the `.dmg` and drag **PM Workbench** to Applications. A signed and notarized build opens
normally.

For an unsigned test build, right-click the app and choose **Open**, or run:
`xattr -dr com.apple.quarantine "/Applications/PM Workbench.app"`

There is no auto-update; a new version is installed the same way.
