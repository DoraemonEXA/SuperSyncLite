# Local issue tracker

Each feature has a directory under `.scratch/<feature>/`, relative to the repository root.

- Write the feature specification in `spec.md`.
- Give each ticket its own file in `issues/`, such as `issues/01-upload-retry.md`. Number tickets from `01` within each feature, placing blockers first. Use the full path when referencing a ticket from another feature.
- Record its current triage label on a `Status:` line using the [triage labels](triage-labels.md). Record dependencies on a `Blocked by:` line with the ticket numbers or paths. A ticket can start once its blockers are resolved.
- Append discussion under `## Comments`. When the work is complete, record the outcome and set `Status: resolved`.

For a wayfinding session, keep the decision map in `map.md` alongside the spec. Store each decision ticket in `issues/` with a `Type:` of `research`, `prototype`, `grilling`, or `task`. Among open, unclaimed tickets whose blockers are resolved, take the lowest ticket number and set `Status: claimed`. On resolution, write the answer under `## Answer`, set `Status: resolved`, and link the ticket from the map’s decisions.
