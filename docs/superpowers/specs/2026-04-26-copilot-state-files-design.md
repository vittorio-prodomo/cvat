---
name: copilot-state-files-design
description: Replace Claude-oriented state files with GitHub Copilot-native repository instructions and remove file-based memory surfaces.
---

# Copilot state files conversion design

## Problem

The worktree currently contains `CLAUDE.md`, `MEMORY.md`, and `memory/*.md` files created from a Claude-oriented state-sync workflow. That does not map cleanly to GitHub Copilot.

Note: The conversion described in this spec has already been completed in this worktree; `.github/copilot-instructions.md` now exists. The referenced `CLAUDE.md` was a transient, session-created worktree file and was not a tracked repository file in this branch.

GitHub Copilot's repository-native instruction surface is `.github/copilot-instructions.md`. GitHub Copilot Memory is a separate repository-scoped feature managed on GitHub, not a file-backed surface in the repository.

## Goals

- Replace Claude-oriented instruction files with the GitHub Copilot-native equivalent.
- Remove the fake file-backed "memory" layer so the repository does not imply a direct mapping that GitHub Copilot does not use.
- Preserve the operational guidance that is still useful for Copilot in this worktree.

## Non-goals

- Attempting to create or edit GitHub-hosted Copilot Memory through repository files.
- Preserving the Claude-style state-file structure under different names.
- Expanding the instructions beyond the high-signal guidance needed for this repository.

## Options considered

### Option 1 — Recommended

Create `.github/copilot-instructions.md` from the current `CLAUDE.md`, then delete `CLAUDE.md`, `MEMORY.md`, and `memory/`.

This matches GitHub's documented repository-wide custom instructions model and avoids keeping misleading file-based memory artifacts.

### Option 2

Create `.github/copilot-instructions.md` but keep `memory/` as plain documentation.

This preserves notes, but they are no longer Copilot-native state and would add maintenance burden without a clear GitHub feature mapping.

### Option 3

Keep `CLAUDE.md` because Copilot can read agent-instruction files, and only delete `MEMORY.md` and `memory/`.

This is technically supported, but it is not the most GitHub-native shape and does not satisfy the conversion goal as cleanly as option 1.

## Chosen design

Implement option 1.

### File actions

- Add `.github/copilot-instructions.md`
- Delete `CLAUDE.md`
- Delete `MEMORY.md`
- Delete `memory/`

### Content mapping

Move the durable, repo-wide guidance from `CLAUDE.md` into `.github/copilot-instructions.md`, specifically:

- build/test/lint commands
- repo structure and workspace conventions
- high-signal coding and validation conventions
- current landmines that are likely to matter on the next edit

Do not copy over the `MEMORY.md` index or the `memory/*.md` topic files.

## Constraints and caveats

- Keep `.github/copilot-instructions.md` concise and repository-wide.
- Do not present deleted memory files as if they were backed by GitHub Copilot Memory.
- GitHub-hosted Copilot Memory may exist for this repository if enabled in account or org settings, but it is managed by GitHub and not directly writable here.

## Validation

- Confirm `.github/copilot-instructions.md` exists and contains the migrated guidance.
- Confirm `CLAUDE.md`, `MEMORY.md`, and `memory/` are removed.
- Keep the resulting instructions coherent with the current crop interactor milestone and existing CVAT workflow.
