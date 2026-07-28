# Task

Review branch `{{BRANCH}}` for correctness, security, clarity, and regression risk.

## Branch diff

!`git diff {{TARGET_BRANCH}}...{{BRANCH}}`

## Commits

!`git log {{TARGET_BRANCH}}..{{BRANCH}} --oneline`

# Review

1. Confirm the change solves its issue without unrelated edits.
2. Check Manifest V3 lifecycle and message boundaries, provider-specific selectors, exactly-once submission, delivery evidence, retry safety, and draft preservation.
3. Reject credential leaks, unsafe page-context trust, unjustified permission/host expansion, or automation against live accounts.
4. Follow `.sandcastle/CODING_STANDARDS.md` and existing project patterns.
5. Run `npm test` plus any relevant targeted smoke script.

If correction is needed, make the smallest fix and commit it as `Sandcastle review: <summary>`. Otherwise make no changes. Do not close the GitHub issue or merge the branch.

When complete, output <promise>COMPLETE</promise>.
