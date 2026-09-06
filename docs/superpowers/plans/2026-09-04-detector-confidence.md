# Detector confidence attribute implementation plan

> For agentic workers: execute inline using the executing-plans workflow. User approved text attributes; deployment remains a separate step. Do not commit, push, or modify live annotations.

**Goal:** Preserve each Argus/Indoor prediction confidence as decimal text on its generated shape.

**Architecture:** Both Nuclio packages emit `model_confidence` in attributes and declare it on every model label. Destination CVAT labels use text, empty default, and the existing attribute mapper. The original numeric confidence and masks remain identical. No CVAT production backend or UI changes.

**Tech stack:** Python, pytest, CVAT Django tests with temporary SQLite, Nuclio YAML, Docker.

- [x] Isolate the deployed detector packages in `feat/detector-confidence-attribute`; baseline: 208 tests passed, 2 skipped.
- [x] Extend both package contract tests to require the text attribute in every model label; extend handler tests with distinct scores and exact float round-trip checks. Missing-attribute failures observed; final result: 212 passed, 2 existing skips.
- [x] Replace each handler's empty attribute list with `[{"name": "model_confidence", "value": str(float(score))}]`. Add `{"name":"model_confidence","input_type":"text","values":[""]}` to each model label in `function-gpu.yaml`.
- [x] Add focused Django tests exercising real detector mapping, label renaming, ROI coordinate handling, annotation persistence/reload, blank manual defaults and CVAT XML export in an isolated test database. Four integration tests pass.
- [x] Prepare an explicit-scope schema updater preserving existing label IDs, colors and attributes. Four schema tests pass, including atomic rejection of incompatible fields and idempotent reruns. Preview projects 28/38/40 and standalone task 305: 124 eligible labels, zero existing confidence fields, no mutations.
- [x] Build both candidate images using existing pinned dependency contexts and new model handlers. Compare packaged handlers with synthetic per-class backend output: only attributes differ from deployed images. No live GPU inference performed.
- [x] Record source hashes, image IDs, focused verification and candidate/rollback runtime configurations under `data/deployments/detector-confidence/` in the main checkout.
- [ ] Resolve target project/task scope with the user; obtain deployment authorization before replacing live functions or applying the schema update.

## Subsequent deployment (only after authorization)

1. Read `data/deployments/detector-confidence/candidate-receipt.json` from the main checkout and verify candidate image IDs/source hashes and current live state.
2. Re-run `serverless/pytorch/rfdetr/configure_model_confidence.py` via `docker exec -i cvat_server python - --project <approved IDs> --task <approved standalone IDs>` with the script on stdin. Omit unused target flags. Archive the preview and existing schema, then repeat with `--apply` for exactly the approved scope.
3. Deploy each candidate with `nuctl deploy <function-name> --platform local --project-name cvat --namespace nuclio --file <candidate-runtime.yaml> --run-image <candidate-image>`. Use the prepared image and runtime configuration together, never the repository root as a build context.
4. Check function readiness and CVAT model metadata; verify a real prediction through the CVAT gateway has the mapped confidence attribute. Avoid saving test annotations into user jobs without an explicit need.
5. In the browser, reload the job so it sees the new schema. Existing label mappings need a `model_confidence` to `model_confidence` attribute mapping; matching names auto-map when the mapping is constructed.
6. If a function fails, redeploy its saved rollback runtime YAML with its original image. Keep the additive schema field and any generated values; deleting it would erase stored confidence data.
