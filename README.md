# Claude Code + Codex concurrent workspace

This repository uses isolated Git worktrees so Claude Code and Codex can work at the same time without writing to the same files.

Claude Code is the default lead agent for substantive tasks (about 70–80% of the work). Codex coordinates the work, handles sensitive local inputs, independently verifies results, integrates approved commits, and deploys the finished result.

## Workspace map

| Role | Folder | Branch |
| --- | --- | --- |
| Integration | repository root | `main` |
| Codex | `.worktrees/codex` | `agent/codex` |
| Claude Code | `.worktrees/claude` | `agent/claude` |

## Daily workflow

1. Open `.worktrees/claude` in VS Code and use the official Claude Code extension.
2. Open `.worktrees/codex` as the Codex workspace.
3. Give Claude the main analysis/implementation/test deliverable and Codex a separate verification/integration deliverable.
4. Each agent commits coherent work on its own branch.
5. Codex reviews both results; merge from the repository root only with explicit user approval.

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
