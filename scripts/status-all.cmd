@echo off
setlocal
set "REPO_ROOT=%~dp0.."

echo [main] %REPO_ROOT%
git -C "%REPO_ROOT%" status --short --branch

echo [codex] %REPO_ROOT%\.worktrees\codex
if exist "%REPO_ROOT%\.worktrees\codex" (
  git -C "%REPO_ROOT%\.worktrees\codex" status --short --branch
) else (
  echo   workspace not created
)

echo [claude] %REPO_ROOT%\.worktrees\claude
if exist "%REPO_ROOT%\.worktrees\claude" (
  git -C "%REPO_ROOT%\.worktrees\claude" status --short --branch
) else (
  echo   workspace not created
)

endlocal
