# Shared AI Development Rules

This repository is developed concurrently with Codex and Claude Code.

## Default workload policy

For every substantive project task, Claude Code is the lead implementation agent by default.

- Assign roughly 70–80% of meaningful work to Claude: requirements analysis, architecture, backend and core feature implementation, tests, and first-pass code review.
- Assign roughly 20–30% to Codex: orchestration, local/private-file inspection, integration review, independent verification, deployment, and final reporting.
- Give Claude complete, bounded deliverables instead of token-burning or duplicate busywork. Use enough turns for implementation and a second review when useful.
- Codex must inspect Claude's diff and test evidence before integration; Claude output is not accepted solely because it completed.
- When source material is private or outside the repository, Codex handles it locally and gives Claude a sanitized summary unless the user explicitly approves sending that material to Anthropic.
- Small mechanical changes may be handled directly when delegation would add no meaningful value.

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
