# RF-DETR Interactor Inference Threshold Design

## Goal

Add an editable **server-side inference threshold** control for the three RF-DETR interactors:

- `RF-DETR Eagle Shape v5`
- `RF-DETR Eagle Stain v5`
- `RF-DETR Eagle Combined v5`

The user should be able to change the threshold in the interactor UI before invoking inference, and that value should be used by the serverless function for that specific request.

## Scope

This design covers:

- interactor UI support for a per-session threshold control
- request plumbing for interactor `extra_params`
- RF-DETR serverless metadata and runtime handling
- tests for the new request path and runtime behavior

Expected user-visible behavior:

1. the user selects one of the three RF-DETR interactors
2. the UI shows an **Inference threshold** control
3. the control defaults to `0.2`
4. the user may set a value in the range `0.05` to `0.99`
5. the next interactor request sends that value to the backend
6. the backend uses that value during inference

## Non-Goals

- no change to non-RF-DETR interactors
- no change to the existing post-response confidence filter semantics
- no persistence across page reloads or interactor switches
- no per-backend threshold split for the combined interactor

## Approved design choices

### 1. Reuse `extra_params_schema` / `extra_params`

The design will extend the existing model-parameter mechanism into the interactor flow instead of inventing a new RF-DETR-only payload path.

RF-DETR interactor manifests will declare one extra parameter:

- `confidence_threshold`

The interactor UI will render a control only when the selected interactor exposes that schema, and the interactor request will send the chosen value through `extra_params`.

### 2. RF-DETR-only rollout via metadata

The UI support should be generic enough to read interactor `extraParamsSchema`, but only the three RF-DETR interactors will declare and consume the threshold parameter in the initial rollout.

This keeps the UI extensible without broadening product scope.

### 3. One shared threshold for the combined interactor

`RF-DETR Eagle Combined v5` will expose one `confidence_threshold` field and apply that same validated value to both internal backend calls.

## Product behavior summary

1. The user selects an RF-DETR interactor.
2. CVAT displays an **Inference threshold** control for that interactor.
3. The control starts at `0.2`.
4. The user may edit the value within `0.05` to `0.99`.
5. When the user invokes the interactor, CVAT sends:
   - the existing image/box/mapping data
   - `extra_params.confidence_threshold`
6. The RF-DETR function validates the incoming value.
7. If valid, the function uses it for that request.
8. If absent, the function falls back to the current default `0.2`.

## Architecture

### 1. Manifest metadata

Each RF-DETR interactor manifest should advertise an `extra_params_schema` entry for `confidence_threshold` with:

- numeric type
- default `0.2`
- minimum `0.05`
- maximum `0.99`
- user-facing title/description that clearly indicates this affects **inference**

No other interactor manifests need to change.

### 2. Core interactor request path

The interactor call path in `cvat-core` should accept and forward `extra_params` the same way detector flows already do.

Responsibilities:

- accept local interactor parameter values from the UI layer
- include them in the lambda request payload under `extra_params`
- preserve existing request behavior for interactors that do not use extra params

### 3. UI control flow

`tools-control` should:

- detect whether the selected interactor exposes `extraParamsSchema`
- initialize a local per-session parameter state for the active interactor
- render an **Inference threshold** control for RF-DETR interactors through the schema-driven path
- send the current value with each interactor invocation

This state should be local to the active interactor session and reset when the user switches interactors or reloads the page.

### 4. RF-DETR runtime handling

Each RF-DETR handler should read `extra_params.confidence_threshold` from the request payload and use it as the request-level confidence threshold.

The combined interactor should read the value once and pass the same threshold into both shape and stain backends.

## UI behavior

The new control should be visually distinct from the existing post-response confidence filter.

Rules:

- label it explicitly as **Inference threshold**
- show it only for interactors that declare the schema
- default to `0.2`
- allow only `0.05` to `0.99`
- keep it session-local and non-persistent
- leave the existing client-side confidence filter unchanged

The existing filter and the new inference control represent different stages:

- **Inference threshold** affects what the backend predicts
- **Confidence filter** affects which returned shapes remain visible in the browser

## Payload and API behavior

The interactor payload should continue using the current request shape with one addition:

```json
{
  "extra_params": {
    "confidence_threshold": 0.35
  }
}
```

Behavior rules:

- always send the current UI value under `extra_params.confidence_threshold`, including the default `0.2`
- always validate on the server side, not only in the browser
- preserve current behavior for interactors that do not define or consume extra params

Lambda-manager already supports forwarding `extra_params`; the interactor flow should reuse that behavior instead of adding a separate field.

## Error handling

The system should fail clearly on invalid user input rather than silently substituting a different value.

### UI-side validation

- prevent values outside `0.05` to `0.99`
- prevent non-numeric submission

### Server-side validation

- accept missing value and fall back to `0.2`
- reject malformed, non-numeric, or out-of-range values with an explicit request failure

### Combined interactor behavior

- use one validated value for both backends
- do not let one backend use a different threshold from the other
- keep all existing failure semantics unchanged

## Testing strategy

### 1. Serverless unit tests

For shape, stain, and combined:

- default threshold is used when request-level override is absent
- custom threshold is propagated correctly
- invalid threshold fails explicitly
- combined handler passes the same override to both backends

### 2. Lambda-manager / API tests

- interactor invocation accepts and forwards `extra_params`
- RF-DETR metadata exposes the expected `extra_params_schema`

### 3. Frontend tests

- schema-driven control appears only when declared
- default value initializes to `0.2`
- edited value is included in the outgoing interactor payload
- control resets when interactor session changes

### 4. Cypress coverage

- RF-DETR interactor flow shows the **Inference threshold** control
- changing the field affects the outgoing request payload

## Implementation notes

- Prefer a schema-driven interactor parameter rendering path over a hardcoded RF-DETR branch in the UI.
- Keep the rollout limited to the three RF-DETR interactors by declaring metadata only on those manifests.
- Do not collapse the new inference control into the existing post-response confidence filter; they must remain separate in both wording and behavior.
