# Telemetry

**PM Workbench has no telemetry, analytics, usage tracking, crash reporting or auto-update.**

- Nothing in the code sends data anywhere except the GitHub API calls described in
  [network.md](network.md). The network allow-list would refuse anything else, and its tests
  prove it.
- Electron's `crashReporter` is never started.
- None of the shipped dependencies ([dependencies.md](dependencies.md)) is an analytics,
  telemetry, crash-reporting or update SDK.
- Logs go to the process's standard error only. They are not written to disk by the app and not
  sent anywhere.
