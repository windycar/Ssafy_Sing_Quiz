# Claude Code + Codex concurrent workspace

This repository uses isolated Git worktrees so Claude Code and Codex can work at the same time without writing to the same files.

## Workspace map

| Role | Folder | Branch |
| --- | --- | --- |
| Integration | repository root | `main` |
| Codex | `.worktrees/codex` | `agent/codex` |
| Claude Code | `.worktrees/claude` | `agent/claude` |

## Daily workflow

1. Open `.worktrees/claude` in VS Code and use the official Claude Code extension.
2. Open `.worktrees/codex` as the Codex workspace.
3. Give each agent a separate, clearly scoped task.
4. Ask each agent to commit its work.
5. Review and merge the commits from the repository root.

Example integration commands:

```powershell
git switch main
git merge --no-ff agent/claude
git merge --no-ff agent/codex
```

If both branches change the same lines, merge one branch first and resolve the second merge carefully.

## Refreshing an agent branch from main

Run this inside that agent's worktree when its status is clean:

```powershell
git merge main
```

Do not store secrets in prompts, committed files, or agent instructions. Use a local `.env` file and provide a sanitized `.env.example` when configuration is needed.

