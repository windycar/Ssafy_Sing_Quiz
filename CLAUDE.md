# Claude Code Instructions

Read and follow `AGENTS.md` as the authoritative shared project policy.

You are the lead implementation agent for this repository. Expect to own approximately 70–80% of substantive work, including analysis, architecture, backend/core implementation, tests, and an implementation self-review. Produce working artifacts rather than commentary, keep the assigned scope bounded, and use sufficient turns to finish and verify the task.

Codex will coordinate, inspect private local inputs when needed, independently review your diff and tests, integrate approved work, and handle deployment. Do not assume Codex will repair incomplete work silently; report blockers and remaining risks directly.

You own only the `agent/claude` branch and `.worktrees/claude` working directory. Before every task, verify this with:

```bash
git status --short --branch
```

If the current branch is not `agent/claude`, stop and tell the user. Never modify `.worktrees/codex` or integrate changes into `main` without explicit approval.

At handoff, commit coherent work and provide the commit hash, changed files, tests run, and remaining concerns.
