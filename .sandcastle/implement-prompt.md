# Context

## Ready issues

!`gh issue list --state open --label Sandcastle --limit 100 --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`

This filtered list is the sole work queue. If empty, do nothing.

## Recent Sandcastle commits

!`git log --oneline --grep="Sandcastle:" -10`

# Task

Implement the highest-priority unblocked issue: bugs, thin end-to-end fixes, polish, then refactors.

1. Read the issue, `README.md`, `PROVIDER_AUTOMATION.md`, relevant source, and tests.
2. Make the smallest complete change. Add or update a regression test first when practical.
3. Run `npm test`. Run a targeted smoke script when the changed behavior has one.
4. Commit once with subject `Sandcastle: <summary>` and explain important decisions in the body.
5. Comment on the issue with the branch `{{SOURCE_BRANCH}}`, verification performed, and that it awaits human review. Do not close the issue.

# Rules

- Work on one issue only.
- Never use live provider accounts or the user's active Chrome profile.
- Preserve Manifest V3 behavior, exactly-once submission, strong delivery evidence, and failed-draft recovery.
- Do not broaden extension permissions or host access unless the issue explicitly requires and justifies it.
- Never commit credentials, generated profiles, screenshots, recordings, or build artifacts.
- If blocked, comment on the issue with the blocker; do not commit or close it.

# Done

When finished, blocked, or the queue is empty, output:

<promise>COMPLETE</promise>
