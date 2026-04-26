# Copilot State Files Conversion Implementation Plan

> NOTE: This document is a historical/session record. The conversion described here was executed during the session that produced these files. `.github/copilot-instructions.md` has already been created in this worktree. The `CLAUDE.md` referenced below was a transient, session-created file and is no longer present in branch history. The remaining steps below are preserved as a record of what was executed.

> **For agentic workers (archived from executed plan):** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. This header is preserved from the executed plan for historical record; steps below are recorded using checkbox (`- [x]`) syntax.

**Goal:** Replace Claude-oriented state files in this worktree with `.github/copilot-instructions.md` and remove the file-based memory layer.

**Architecture:** Migrate only the durable repository-wide guidance from `CLAUDE.md` into GitHub Copilot's native repository instructions file. Delete `CLAUDE.md`, `MEMORY.md`, and `memory/` entirely instead of trying to emulate GitHub-hosted Copilot Memory with repository files.

**Tech Stack:** Markdown, GitHub Copilot repository instructions, shell validation commands

---

## File structure

- Create: `.github/copilot-instructions.md` — repository-wide GitHub Copilot instructions for this worktree.
- Delete: `CLAUDE.md` — Claude-oriented always-loaded instructions file.
- Delete: `MEMORY.md` — Claude-oriented memory index.
- Delete: `memory/project_phase.md` — Claude-oriented project phase memory note.
- Delete: `memory/crop_interactor_arch.md` — Claude-oriented architecture memory note.
- Delete: `memory/cypress_interactor.md` — Claude-oriented Cypress finding note.
- Delete: `memory/finding_runtime_landmines.md` — Claude-oriented landmines note.

### Task 1: Create GitHub Copilot repository instructions

**Files:**
- Create: `.github/copilot-instructions.md`
- Source: transient session-created `CLAUDE.md:1-55` (snapshot; not present in branch history)

- [x] **Step 1: Write the new instructions file**

```md
# GitHub Copilot Instructions

## Repository overview

- CVAT is a Docker Compose-first monorepo with a Django backend under `cvat/`, a Yarn workspace frontend across `cvat-ui`, `cvat-core`, `cvat-data`, `cvat-canvas`, and `cvat-canvas3d`, and serverless integrations under `serverless/`.
- For frontend work, operate from the repository root with Yarn 4 workspaces instead of treating each package as isolated.
- For backend flows that depend on Postgres, Redis, OPA, storage, or serverless services, prefer the existing Docker Compose overlays.

## Build, test, and validation

- Enable Corepack and install workspace dependencies with `corepack enable yarn && yarn --immutable`.
- Lint frontend changes with `yarn workspace cvat-ui run lint`.
- Type-check frontend changes with `yarn workspace cvat-ui run type-check` and `yarn workspace cvat-core run type-check`.
- For Django lambda-manager baseline checks, install test requirements with `pip install -r cvat/requirements/testing.txt` and run `python manage.py test --settings cvat.settings.testing cvat.apps.lambda_manager.tests.test_lambda -v 2`.
- For the crop interactor browser verification flow, run:
  `cd tests && npx cypress run --config baseUrl=https://lambda.the-commander.net --env user=<user>,password=<password>,taskID=<task>,jobID=<job> --browser chrome --spec cypress/e2e/features2/crop_instance_segmentation_interactor.js`

## Conventions

- Keep interactor UX in `tools-control` instead of detector-runner flows.
- Treat per-shape interactor labels as authoritative; only fall back to the active label for legacy unlabeled responses.
- Keep crop instance-segmentation backends thin and share crop, reprojection, NMS, and CVAT RLE helpers.
- Return full-image CVAT mask RLEs from interactors; placeholder mask arrays do not work.
- For headless interactor UI tests, prefer AUT-native canvas events over Cypress `.trigger()` when browser behavior matters.

## Current landmines

- Host-side `lambda_manager` tests need localhost OPA/Redis ports from `docker-compose.dev.yml`.
- The SAM3 interactive path must use the `sam3` checkpoint unless a compatible custom checkpoint is supplied.
- In no-Traefik setups behind an external reverse proxy, verify the live `cvat_ui` bind port before chasing 502s.
- Headless Cypress interactor specs need AUT-native canvas events, a post-response finish event, and valid CVAT mask RLE mocks.
```

- [x] **Step 2: Create the file with the content above**

Run:

```bash
mkdir -p .github
${EDITOR:-vi} .github/copilot-instructions.md
```

Expected: `.github/copilot-instructions.md` exists with the migrated repository guidance.

- [x] **Step 3: Verify the new file exists and is readable**

Run:

```bash
test -f .github/copilot-instructions.md && sed -n '1,120p' .github/copilot-instructions.md
```

Expected: the file prints the migrated instructions and exits successfully.

- [x] **Step 4: Commit the new instructions file**

```bash
git add .github/copilot-instructions.md
git commit -m "docs: add copilot instructions"
```

### Task 2: Remove the Claude-oriented state files

**Files:**
- Delete: `CLAUDE.md`
- Delete: `MEMORY.md`
- Delete: `memory/project_phase.md`
- Delete: `memory/crop_interactor_arch.md`
- Delete: `memory/cypress_interactor.md`
- Delete: `memory/finding_runtime_landmines.md`

- [x] **Step 1: Delete the Claude-oriented files**

```bash
rm -f CLAUDE.md MEMORY.md
rm -rf memory
```

- [x] **Step 2: Verify the files are gone**

Run:

```bash
! test -e CLAUDE.md
! test -e MEMORY.md
! test -e memory
```

Expected: all commands succeed with no output.

- [x] **Step 3: Review the diff**

Run:

```bash
git --no-pager diff -- .github/copilot-instructions.md CLAUDE.md MEMORY.md memory
```

Expected: the diff shows the new Copilot instructions file and removal of the Claude-oriented files only.

- [x] **Step 4: Commit the removal**

```bash
git add -A .github/copilot-instructions.md CLAUDE.md MEMORY.md memory
git commit -m "docs: replace claude state files with copilot instructions"
```

### Task 3: Final validation and cleanup

**Files:**
- Check: `.github/copilot-instructions.md`
- Check: repository root state-file layout

- [x] **Step 1: Validate the final instruction surface**

Run:

```bash
test -f .github/copilot-instructions.md
! test -e CLAUDE.md
! test -e MEMORY.md
! test -e memory
```

Expected: only `.github/copilot-instructions.md` remains.

- [x] **Step 2: Confirm the new file is the only Copilot-facing state file in the root**

Run:

```bash
find . -maxdepth 2 \( -name 'copilot-instructions.md' -o -name 'CLAUDE.md' -o -name 'MEMORY.md' \) | sort
```

Expected:

```text
./.github/copilot-instructions.md
```

- [x] **Step 3: Review git status**

Run:

```bash
git status --short
```

Expected: no unexpected file changes outside `.github/copilot-instructions.md` and the intended deletions.

- [x] **Step 4: Create the final docs commit**

```bash
git add -A .github/copilot-instructions.md CLAUDE.md MEMORY.md memory
git commit -m "docs: convert state files to copilot instructions"
```
