#!/usr/bin/env bash
# Set SMOKE_BIN to the packaged executable to test that instead of running from source.
# Launches the built app against a throwaway data folder with no GitHub token configured and
# checks that it starts cleanly: a window opens, the strict CSP and preload bridge are in place,
# and nothing crashes. This replaces the old scanning-era smoke test (Phase 1 dropped the local
# folder scanner, so there is no longer a Development folder or scan result to assert on); it is
# a narrower check than before, intentionally, until Phase 2+ gives it a product to exercise.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build --silent
work="$(mktemp -d)"
mkdir -p "$work/data"
out="${SMOKE_OUT:-$work/smoke}"
# xvfb-run provides a display on headless Linux CI; on a Mac the window just opens and closes.
display=""; command -v xvfb-run >/dev/null 2>&1 && display="xvfb-run -a"
env -u GITHUB_TOKEN PMWORKBENCH_HOME="$work/data" PMWORKBENCH_SMOKE="$out" \
  $display ${SMOKE_BIN:-npx electron .} --no-sandbox --disable-gpu 2>&1 | grep SMOKE_RESULT | tee "$work/result.txt"
echo "screenshot: $out.png"
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").replace(/^SMOKE_RESULT /, ""));
const expectKeys = ["addLinks","browseTree","checkLinks","createProduct","deleteProduct","exportProduct","getAuth","getProduct","getSettings","importProduct","listAvailableRepos","listProducts","listPulls","readFile","readPull","removeLink","saveSettings","signIn","signOut","updateLink","updateProduct"];
const checks = {
  "no launch error": !r.error,
  "signed out with no token configured": r.authStatus === "signed-out",
  "bridge exposes exactly the intended methods": JSON.stringify(r.bridgeKeys) === JSON.stringify(expectKeys),
  "Node is not reachable from the page": r.nodeLeaked === false,
  "strict script policy": typeof r.csp === "string" && r.csp.includes("script-src '"'"'self'"'"';") && !/script-src[^;]*unsafe/.test(r.csp),
  "renderer has no connect-src escape hatch": typeof r.csp === "string" && r.csp.includes("connect-src '"'"'self'"'"';"),
};
let bad = 0;
for (const [k, v] of Object.entries(checks)) { console.log((v ? "PASS " : "FAIL ") + k); if (!v) bad++; }
process.exit(bad ? 1 : 0);
' "$work/result.txt"
