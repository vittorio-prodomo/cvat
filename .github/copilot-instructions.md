# GitHub Copilot Instructions

## Repository overview

- CVAT is a Docker Compose-first monorepo with a Django backend under `cvat/`, a Yarn workspace frontend across `cvat-ui`, `cvat-core`, `cvat-data`, `cvat-canvas`, and `cvat-canvas3d`, and serverless integrations under `serverless/`.
- For frontend work, operate from the repository root with Yarn 4 workspaces instead of treating each package as isolated.
- For backend flows that depend on Postgres, Redis, OPA, storage, or serverless services, prefer the existing Docker Compose overlays.

## Build, test, and validation

- Enable Corepack and install workspace dependencies with `corepack enable yarn && yarn --immutable`.
- Lint frontend changes with `yarn workspace cvat-ui run lint`.
- Type-check frontend changes with `yarn workspace cvat-core run type-check`. 
- For Django lambda-manager baseline checks, install test requirements with `pip install -r cvat/requirements/testing.txt` and run `python manage.py test --settings cvat.settings.testing cvat.apps.lambda_manager.tests.test_lambda -v 2`.
- For the crop interactor browser verification flow, run:
  `cd tests && npx cypress run --config baseUrl=https://lambda.the-commander.net --env user=<user>,password=<password>,taskID=<task>,jobID=<job> --browser chrome --spec cypress/e2e/features2/crop_instance_segmentation_interactor.js`

## Conventions

- Keep interactor UX in `tools-control` instead of detector-runner flows.
- Treat per-shape interactor labels as authoritative; only fall back to the active label for legacy unlabeled responses.
- Keep crop instance-segmentation backends thin and share crop, reprojection, NMS, and CVAT RLE helpers.
- Return full-image CVAT mask RLEs from interactors; placeholder mask arrays do not work.
- If adding more crop interactor backends, give each backend its own Nuclio directory and function metadata instead of reusing one shared function config.
- For headless interactor UI tests, prefer AUT-native canvas events over Cypress `.trigger()` when browser behavior matters.

## Current focus

- Recently shipped: the crop instance-segmentation interactor vertical slice is now on `develop`, including mapped-label UI support, the Ultralytics backend, and the passing external Cypress verification flow.
- Queued next: treat the current crop interactor as the reference implementation and add future backends as separate Nuclio functions/directories rather than piling multiple backends into one deployable function.

## Current landmines

- Host-side `lambda_manager` tests need localhost OPA/Redis ports from `docker-compose.dev.yml`.
- The SAM3 interactive path must use the `sam3` checkpoint unless a compatible custom checkpoint is supplied.
- In no-Traefik setups behind an external reverse proxy, verify the live `cvat_ui` bind port before chasing 502s.
- Headless Cypress interactor specs need AUT-native canvas events, a post-response finish event, and valid CVAT mask RLE mocks.
- `serverless/deploy_gpu.sh` expects a Nuclio directory path (the one containing `function-gpu.yaml`), not the YAML file path itself.
