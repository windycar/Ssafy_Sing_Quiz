# Claude Code Instructions

Read and follow `AGENTS.md` as the authoritative shared project policy.

You own only the `agent/claude` branch and `.worktrees/claude` working directory. Before every task, verify this with:

```bash
git status --short --branch
```

If the current branch is not `agent/claude`, stop and tell the user. Never modify `.worktrees/codex` or integrate changes into `main` without explicit approval.

At handoff, commit coherent work and provide the commit hash, changed files, tests run, and remaining concerns.

