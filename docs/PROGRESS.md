# Localise development progress

## Shared baseline
- Base: main at 74473f7ed37a5180653bbbb824c03f7f285c858d.
- Baseline commit: 69be29b98cc3053951cc9eee99a22f7be1effa3c.
- Temporary CodeRabbit review history and REVIEW.md are excluded.
- Worker/API inspection is complete. Existing and planned endpoints are distinguished in contracts/openapi.yaml.
- No frontend or itinerary source existed at setup.

## Parallel work
- Feature worktrees/branches and task briefs are established in the setup commit.
- Overnight launcher is available at scripts/run_overnight.ps1.
- Review timestamped logs, machine-readable status, and morning-summary.json under the generated overnight run directory.
- Checkpoint: agents use their own ignored .overnight/progress.json.
- Storage policy: C: only; warn below 30 GB; pause storage-intensive work below 20 GB; check every 15 minutes during collection. Do not download bulk photographs.

The integration coordinator updates this file after tested integration milestones. Do not have parallel agents edit this shared file.
