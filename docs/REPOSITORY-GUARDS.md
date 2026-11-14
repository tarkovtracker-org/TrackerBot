# Repository protection and annual license automation

This document proposes the remaining owner-approved policy for issue #55. Source
changes do not configure GitHub branch protection, rulesets, token settings, or
repository variables. Do not close the issue until the effective server-side
policy and its negative/positive checks are verified.

## Proposed default-branch policy (owner decision)

- Require pull requests and one approving review on the current changes.
- Require `check (ubuntu-latest)` and `check (windows-latest)` on an up-to-date
  branch; retain existing CodeQL, Socket, Snyk and code-review integrations.
- Block force pushes and deletion of the default branch.
- No broad administrator, automation, or organization-role bypass. Any exception
  requires a named owner-approved actor and a documented operational need.
- Decide whether approval must be from a human/code owner rather than treating a
  bot approval as equivalent. Do not silently promise human review when the
  effective GitHub rule only counts generic approving reviews.

After owner approval, configure the effective rule through GitHub's trusted UI/API
and read it back. Verify an intentionally failing candidate is blocked and an
approved green candidate can merge; use an authorized disposable test PR, never
weaken CI or execute an unapproved merge to test enforcement. Also verify the
license workflow below cannot push directly to the protected default branch.

## License PR workflow

The replacement annual job no longer commits or pushes to the default branch.
It creates `automation/license-year-YYYY` and a normal, reviewable license-only PR.
The original copyright start year is retained. Existing matching open PRs are
reused without force-pushing; unknown, closed, contaminated, or ambiguous branch
state fails closed for owner inspection. Failed/unconfirmed writes are not retried
automatically. Only the `LICENSE` file is staged and committed.

The job is **disabled until the owner sets repository variable
`LICENSE_PR_AUTOMATION_ENABLED=true`**. Its script independently enforces the same
flag, expected repository, schedule/manual event, exact default-branch ref, clean
checkout and trusted workflow revision. No pull-request/fork event can run its
write path. Checkout is immutable and does not persist credentials; a scoped
GitHub CLI credential helper authenticates remote reads and the topic-branch push.
There is no new PAT/App secret, auto-approval, auto-merge, privileged PR checkout,
or `actions: write` dispatch bypass.

Before enabling the variable, the owner must explicitly approve enabling
**Allow GitHub Actions to create and approve pull requests** in repository Actions
settings. Keep the default workflow token permission **read**; only this trusted
job requests Contents/Pull requests write. GitHub combines creation and approval
in that setting; enabling it is a security-policy decision, not something this
PR changes. The workflow never submits approvals.

GitHub documents that PRs created/updated with `GITHUB_TOKEN` can queue their
`pull_request` workflow runs in an approval-required state. An authorized human
must inspect the license-only diff and choose **Approve workflows to run** when
prompted. The normal CI checks and review gate must pass before merge; a missing
or pending check is not a successful check. If a trusted manual CI dispatch is
needed, an authorized maintainer may run `CI` for the reviewed topic branch; this
workflow does not grant itself Actions write or bypass fork protections.

A current-year no-op workflow run proves only the trusted read/no-change path,
not live PR-creation permission. Unit tests exercise future years, PR reuse,
transport errors, unexpected files and no-retry behavior without making GitHub
writes. Verify the end-to-end topic/PR path only through an owner-approved smoke
test. Disabling the variable stops future maintenance runs; do not restore the
old direct-default-branch push as a workaround.

References:
- [Triggering workflows and GITHUB_TOKEN](https://docs.github.com/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
- [Repository Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)
