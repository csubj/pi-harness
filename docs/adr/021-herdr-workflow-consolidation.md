# 021. One Herdr Workflow Extension

- **Status:** accepted
- **Date:** 2026-10-05
- **Amended by:** [ADR 022](022-multi-repo-targets-and-command-panes.md) (proposed). It adds command panes, a `repo` field for `herdr_handoff`, and workspace-based `/done`.

`@csubj/pi-herdr-tools` supplies clone, completion, side-thread, and title behavior in one package with one extension entry point. Each feature stays in a separate internal module, so each feature keeps its own safety boundaries. This design reduces installation and loaded-extension count. The shared `@csubj/pi-herdr` CLI library remains separate for other consumers.

We accept that users cannot select one feature as a native Pi resource. We do not add feature-toggle configuration or wrapper packages. Commands, task-model IDs, title session entries, side-thread payload flags, config paths, and pending-delivery storage keep their earlier identifiers. Thus, existing user data stays valid without migration.
