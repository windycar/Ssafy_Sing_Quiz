# Shared AI Development Rules

This repository is developed concurrently with Codex and Claude Code.

## Workspace ownership

- Codex works only on branch `agent/codex` in `.worktrees/codex`.
- Claude works only on branch `agent/claude` in `.worktrees/claude`.
- The repository root on branch `main` is integration-only. Do not implement features directly there.
- Never edit files inside the other agent's worktree.

## Before changing code

1. Run `git status --short --branch` and confirm the expected branch.
2. Read this file, `README.md`, and any task-specific documentation.
3. Pull or merge recent `main` changes before starting a large task.
4. Keep each task small enough to review and merge independently.

## Implementation rules

- Do not overwrite or discard uncommitted work.
- Do not commit `.env`, credentials, API keys, tokens, or personal data.
- Add or update tests for behavior changes and run relevant checks before handoff.
- Avoid unrelated refactors and dependency upgrades.
- Use clear commit messages: `type(scope): summary`.

## Handoff protocol

When a task is complete, report:

- branch and commit hash;
- files changed;
- checks run and their results;
- known risks or follow-up work.

Do not merge into `main` unless the user explicitly requests integration.

