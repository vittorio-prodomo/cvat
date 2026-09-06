// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

/// <reference types="cypress" />

const INTERMEDIATE_SHAPE = '.cvat_canvas_interact_intermediate_shape';
const MASK_OUTLINE = '.cvat_canvas_interact_mask_outline';
const SIDEBAR_ITEM = '.cvat-objects-sidebar-state-item';
const PREVIEW_CHECKBOX = '.cvat-detector-preview-confidence-checkbox';
const LEGACY_THRESHOLD = '.cvat-detector-confidence-threshold';
const POSTPROCESSING_METHOD = '.cvat-detector-postprocessing-method';
const POSTPROCESSING_METRIC = '.cvat-detector-postprocessing-metric';
const POSTPROCESSING_THRESHOLD = '.cvat-detector-postprocessing-threshold';
const POSTPROCESSING_ERROR = '.cvat-detector-postprocessing-error';
const PREVIEW = '.cvat-detector-preview-wrapper';
const PREVIEW_SLIDER = '.cvat-detector-preview-slider';
const PREVIEW_CANCEL = '.cvat-detector-preview-cancel';
const PREVIEW_DONE = '.cvat-detector-preview-done';
const PREVIEW_RETRY = '.cvat-detector-preview-retry';
const PREVIEW_ERROR = '.cvat-detector-preview-error';
const RUN_BUTTON = '.cvat-inference-run-button';
const detector = {
    id: 'test-detector-preview',
    name: 'Mock detector preview',
    kind: 'detector',
    description: 'Mock detector preview',
    version: 2,
    labels_v2: [
        {
            name: 'damage',
            type: 'mask',
            attributes: [{ name: 'model_confidence', input_type: 'text', values: [] }],
        },
        {
            name: 'stain',
            type: 'mask',
            attributes: [{ name: 'model_confidence', input_type: 'text', values: [] }],
        },
    ],
};

function getReactFiber(element) {
    const fiberKey = Object.getOwnPropertyNames(element).find(
        (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'),
    );

    return fiberKey ? element[fiberKey] : null;
}

function getToolsControlComponent(win) {
    const element = win.document.querySelector('.cvat-tools-control');

    if (!element) {
        return null;
    }

    let fiber = getReactFiber(element);
    while (fiber) {
        const { stateNode } = fiber;
        if (
            stateNode &&
            typeof stateNode === 'object' &&
            stateNode.interaction &&
            stateNode.state &&
            Object.prototype.hasOwnProperty.call(stateNode.state, 'interactorResponseReceived')
        ) {
            return stateNode;
        }

        fiber = fiber.return;
    }

    return null;
}

function requireToolsControlComponent(win) {
    const toolsControlComponent = getToolsControlComponent(win);

    if (!toolsControlComponent) {
        throw new Error('Missing ToolsControlComponent');
    }

    return toolsControlComponent;
}

function putTemporaryShapes(win, shapes) {
    const tools = requireToolsControlComponent(win);
    tools.props.canvasInstance.interact({
        enabled: true,
        command: 'put_shapes',
        payload: { shapes },
    });
}

function clearTemporaryShapes(win) {
    const tools = getToolsControlComponent(win);
    const canvas = tools?.props?.canvasInstance;

    if (canvas) {
        canvas.interact({ enabled: false });
    }
}

function openDetectorsWithModels(models) {
    cy.get('.cvat-tools-control').should('exist').click();
    cy.get('.cvat-tools-control-popover:visible').within(() => {
        cy.contains('.ant-tabs-tab', 'Detectors').click();
        cy.contains('.ant-row', 'Model:').find('.ant-select').click();
    });
    cy.get('.ant-select-dropdown:visible').contains('.ant-select-item-option-content', models[0].name).click();
}

function readTaskDetectorMetadata() {
    return cy.window().then((win) => {
        const { labels } = requireToolsControlComponent(win).props.jobInstance;
        const damage = labels.find(({ name }) => name === 'damage');
        const stain = labels.find(({ name }) => name === 'stain');

        return {
            labelIds: { damage: damage.id, stain: stain.id },
            attributeSpecIds: {
                damage: damage.attributes.find(({ name }) => name === 'model_confidence').id,
                stain: stain.attributes.find(({ name }) => name === 'model_confidence').id,
            },
        };
    });
}

function makeShape({
    labelId, type, points, score, confidence, confidenceSpecID,
}) {
    return {
        label_id: labelId,
        frame: 0,
        group: 0,
        source: 'auto',
        type,
        points,
        ...(score === undefined ? {} : { score }),
        occluded: false,
        outside: false,
        rotation: 0,
        z_order: 0,
        attributes: confidence === undefined ? [] : [{
            spec_id: confidenceSpecID,
            value: confidence,
        }],
        elements: [],
    };
}

function makeMask({
    labelId, score, confidence, confidenceSpecID, box,
}) {
    const [left, top, right, bottom] = box;
    const area = (right - left + 1) * (bottom - top + 1);
    return makeShape({
        labelId,
        type: 'mask',
        points: [0, area, left, top, right, bottom],
        score,
        confidence,
        confidenceSpecID,
    });
}

function makeRectangle({ labelId, score, points }) {
    return makeShape({
        labelId, type: 'rectangle', points, score,
    });
}

function makePolygon({ labelId, score, points }) {
    return makeShape({
        labelId, type: 'polygon', points, score,
    });
}

function makePreviewResponse(labelIds, attributeSpecIds) {
    return {
        tags: [{
            label_id: labelIds.damage,
            frame: 0,
            group: 0,
            source: 'auto',
            attributes: [],
        }],
        tracks: [],
        shapes: [
            makeMask({
                labelId: labelIds.damage,
                score: 0.90,
                confidence: '0.9000',
                confidenceSpecID: attributeSpecIds.damage,
                box: [10, 10, 19, 19],
            }),
            makeMask({
                labelId: labelIds.damage,
                score: 0.30,
                confidence: '0.3000',
                confidenceSpecID: attributeSpecIds.damage,
                box: [12, 12, 17, 17],
            }),
            makeRectangle({
                labelId: labelIds.damage,
                score: 0.80,
                points: [30, 10, 45, 25],
            }),
            makeMask({
                labelId: labelIds.stain,
                score: 0.70,
                confidence: '0.7000',
                confidenceSpecID: attributeSpecIds.stain,
                box: [10, 10, 19, 19],
            }),
            makePolygon({
                labelId: labelIds.damage,
                points: [55, 10, 65, 10, 60, 20],
            }),
        ],
    };
}

function makeAllShapeTypesResponse(labelIds) {
    return {
        tags: [],
        tracks: [],
        shapes: [
            makeRectangle({ labelId: labelIds.damage, score: 0.90, points: [10, 40, 25, 55] }),
            makeShape({
                labelId: labelIds.damage, type: 'ellipse', points: [50, 48, 60, 40], score: 0.80,
            }),
            makePolygon({
                labelId: labelIds.damage, score: 0.70, points: [75, 40, 90, 40, 82, 55],
            }),
            makeMask({ labelId: labelIds.damage, score: 0.60, box: [105, 40, 114, 49] }),
            makeShape({
                labelId: labelIds.damage, type: 'polyline', points: [135, 40, 145, 55, 155, 40],
            }),
            makeShape({ labelId: labelIds.damage, type: 'points', points: [175, 45, 185, 50] }),
        ],
    };
}

function makeMalformedMaskResponse(labelIds, attributeSpecIds) {
    const mask = makeMask({
        labelId: labelIds.damage,
        score: 0.90,
        confidence: '0.9000',
        confidenceSpecID: attributeSpecIds.damage,
        box: [10, 10, 11, 11],
    });
    mask.points = [0, 3, 10, 10, 11, 11];
    return { tags: [], tracks: [], shapes: [mask] };
}

function emptyResponse() {
    return { tags: [], tracks: [], shapes: [] };
}

function selectPostprocessingMethod(label) {
    cy.get(POSTPROCESSING_METHOD).click();
    cy.get('.ant-select-dropdown:visible')
        .contains('.ant-select-item-option-content', label).click();
    cy.get(POSTPROCESSING_METHOD).should('contain.text', label);
}

function typeNumericInput(selector, value) {
    cy.get(`${selector} input`).clear();
    if (value !== '') {
        cy.get(`${selector} input`).type(value);
    }
    cy.get(`${selector} input`).blur();
}

function recordSidebarItemIds() {
    return cy.get('body').then(($body) => (
        [...$body.find(SIDEBAR_ITEM)].map(({ id }) => id)
    ));
}

function expectSidebarCount(count) {
    cy.get('body').should(($body) => {
        expect($body.find(SIDEBAR_ITEM)).to.have.length(count);
    });
}

function reopenDetectorPopover() {
    cy.get('.cvat-tools-control').should('not.have.class', 'cvat-active-canvas-control');
    cy.get('.cvat-tools-control').click();
    cy.get('.cvat-tools-control-popover:visible').should('exist');
}

function setPreviewConfidenceAboveEighty() {
    const left = '{leftarrow}'.repeat(19);
    cy.get(`${PREVIEW_SLIDER} [role="slider"]`).focus();
    cy.get(`${PREVIEW_SLIDER} [role="slider"]`).type(`{end}${left}`);
    cy.get(`${PREVIEW_SLIDER} [role="slider"]`)
        .should('have.attr', 'aria-valuenow', '0.81');
    cy.get(PREVIEW).should('contain.text', '2 / 5 results');
    cy.get(PREVIEW_DONE).should('be.enabled');
}

function setPreviewConfidenceToMaximum() {
    cy.get(`${PREVIEW_SLIDER} [role="slider"]`).focus();
    cy.get(`${PREVIEW_SLIDER} [role="slider"]`).type('{end}');
    cy.get(`${PREVIEW_SLIDER} [role="slider"]`)
        .should('have.attr', 'aria-valuenow', '1');
    cy.get(PREVIEW_DONE).should('be.enabled');
}

function assertUIOnlyOptionsAreOmitted(body) {
    expect(body).not.to.have.property('cleanup');
    expect(body).not.to.have.property('postprocessing');
    expect(body).not.to.have.property('previewConfidence');
}

function expectClose(actual, expected) {
    expect(Number.parseFloat(actual)).to.be.closeTo(expected, 0.001);
}

function expectRotation(element, expected) {
    const transform = element.transform.baseVal.consolidate();
    const angle = transform ? (Math.atan2(transform.matrix.b, transform.matrix.a) * 180) / Math.PI : 0;
    expect(angle).to.be.closeTo(expected, 0.001);
}

function temporaryShapeSample() {
    return [
        {
            shapeType: 'rectangle', points: [10, 10, 40, 30], rotation: 15, selected: true,
        },
        { shapeType: 'ellipse', points: [70, 30, 90, 15], rotation: 30 },
        { shapeType: 'polygon', points: [100, 10, 130, 10, 120, 35] },
        {
            shapeType: 'mask',
            points: [0, 4, 150, 10, 151, 11],
            maskOutlines: [[150, 10, 151, 10, 151, 11, 150, 11]],
        },
        { shapeType: 'polyline', points: [180, 10, 200, 30, 220, 10] },
        { shapeType: 'points', points: [240, 20, 255, 25] },
        { shapeType: 'unsupported', points: [] },
    ];
}

context('Detector preview postprocessing', () => {
    const taskName = 'Detector preview postprocessing temporary shapes';
    const serverFiles = ['images/image_1.jpg', 'images/image_2.jpg'];
    let createdTaskId = null;
    let createdJobId = null;

    before(() => {
        cy.visit('/');
        cy.headlessLogin({ nextURL: '/tasks' });
        cy.headlessCreateTask({
            labels: ['damage', 'stain'].map((name) => ({
                name,
                type: 'any',
                attributes: [{
                    name: 'model_confidence',
                    mutable: false,
                    input_type: 'text',
                    default_value: '',
                    values: [],
                }],
            })),
            name: taskName,
            project_id: null,
            source_storage: { location: 'local' },
            target_storage: { location: 'local' },
        }, {
            server_files: serverFiles,
            image_quality: 70,
            use_zip_chunks: true,
            use_cache: true,
            sorting_method: 'lexicographical',
        }).then((taskResponse) => {
            createdTaskId = taskResponse.taskId;
            [createdJobId] = taskResponse.jobIds;
        });
    });

    beforeEach(() => {
        cy.intercept('HEAD', '**/api/lambda/functions**', { statusCode: 200 }).as('basePreviewModelsHead');
        cy.intercept('GET', '**/api/lambda/functions**', { statusCode: 200, body: [detector] })
            .as('basePreviewModels');
        cy.visit(`/tasks/${createdTaskId}/jobs/${createdJobId}`);
        cy.wait('@basePreviewModelsHead');
        cy.wait('@basePreviewModels');
        cy.get('.cvat-canvas-container').should('exist');
    });

    afterEach(() => {
        cy.window({ log: false }).then(clearTemporaryShapes);
    });

    after(() => {
        if (createdTaskId !== null) {
            cy.headlessDeleteTask(createdTaskId);
        }

        cy.headlessLogout();
    });

    it('renders every supported detector shape in the temporary canvas layer', () => {
        cy.window().then((win) => {
            putTemporaryShapes(win, temporaryShapeSample());
            cy.wrap({ ...requireToolsControlComponent(win).props.canvasInstance.geometry }).as('geometry');
        });

        cy.get(INTERMEDIATE_SHAPE).should('have.length', 7).each(($shape) => {
            expect($shape).to.have.attr('pointer-events', 'none');
            expect(Number.parseFloat($shape.attr('stroke-width'))).to.be.greaterThan(0);
        });
        cy.get(`rect${INTERMEDIATE_SHAPE}`).should('have.length', 1).and('have.attr', 'stroke', '#1890ff');
        cy.get(`ellipse${INTERMEDIATE_SHAPE}`).should('have.length', 1).and('have.attr', 'stroke', '#000000');
        cy.get(`polygon${INTERMEDIATE_SHAPE}`).should('have.length', 1);
        cy.get(`image${INTERMEDIATE_SHAPE}`).should('have.length', 1)
            .and('have.attr', 'href').and('match', /^blob:/);
        cy.get(`polyline${INTERMEDIATE_SHAPE}`).should('have.length', 1).and('have.attr', 'fill', 'none');
        cy.get(`circle${INTERMEDIATE_SHAPE}`).should('have.length', 2);
        cy.get(`${MASK_OUTLINE}`).should('have.length', 1)
            .and('have.attr', 'pointer-events', 'none')
            .and('have.attr', 'fill', 'none');

        cy.get('@geometry').then(({ offset }) => {
            cy.get(`rect${INTERMEDIATE_SHAPE}`).then(($rectangle) => {
                expectClose($rectangle.attr('x'), offset + 10);
                expectClose($rectangle.attr('y'), offset + 10);
                expectClose($rectangle.attr('width'), 30);
                expectClose($rectangle.attr('height'), 20);
                expectRotation($rectangle[0], 15);
                expect($rectangle.attr('fill')).to.equal('white');
                expect(Number.parseFloat($rectangle.attr('fill-opacity'))).to.be.within(0, 1);
            });
            cy.get(`ellipse${INTERMEDIATE_SHAPE}`).then(($ellipse) => {
                expectClose($ellipse.attr('cx'), offset + 70);
                expectClose($ellipse.attr('cy'), offset + 30);
                expectClose($ellipse.attr('rx'), 20);
                expectClose($ellipse.attr('ry'), 15);
                expectRotation($ellipse[0], 30);
            });
            cy.get(`image${INTERMEDIATE_SHAPE}`).then(($mask) => {
                expectClose($mask.attr('x'), offset + 150);
                expectClose($mask.attr('y'), offset + 10);
            });
            cy.get(`circle${INTERMEDIATE_SHAPE}`).then(($points) => {
                const centers = [...$points].map((point) => [
                    Number.parseFloat(point.getAttribute('cx')),
                    Number.parseFloat(point.getAttribute('cy')),
                ]).sort(([left], [right]) => left - right);
                expect(centers).to.deep.equal([
                    [offset + 240, offset + 20],
                    [offset + 255, offset + 25],
                ]);
            });
        });
    });

    it('keeps temporary shapes aligned through zoom and fit, then replaces and cancels them', () => {
        let initialGeometry;
        let initialPointRadius;
        let initialStrokeWidth;
        let initialMaskRevocations;
        let zoomedGeometry;
        let fittedOffset;

        cy.window().then((win) => {
            const revokeObjectURL = cy.stub(win.URL, 'revokeObjectURL').callThrough();
            putTemporaryShapes(win, temporaryShapeSample());
            initialGeometry = { ...requireToolsControlComponent(win).props.canvasInstance.geometry };
            initialMaskRevocations = revokeObjectURL.callCount;
        });
        cy.get(`circle${INTERMEDIATE_SHAPE}`).first().then(($point) => {
            initialPointRadius = Number.parseFloat($point.attr('r'));
        });
        cy.get(`rect${INTERMEDIATE_SHAPE}`).then(($rectangle) => {
            initialStrokeWidth = Number.parseFloat($rectangle.attr('stroke-width'));
        });

        cy.get('.cvat-canvas-container').trigger('wheel', {
            deltaY: -5,
            clientX: 500,
            clientY: 400,
        });
        cy.window().should((win) => {
            const { scale } = requireToolsControlComponent(win).props.canvasInstance.geometry;
            expect(scale).not.to.equal(initialGeometry.scale);
        }).then((win) => {
            const { scale } = requireToolsControlComponent(win).props.canvasInstance.geometry;
            zoomedGeometry = { ...requireToolsControlComponent(win).props.canvasInstance.geometry };
            cy.get(INTERMEDIATE_SHAPE).each(($shape) => {
                expectClose(
                    $shape.attr('stroke-width'),
                    (initialStrokeWidth * initialGeometry.scale) / scale,
                );
            });
            cy.get(`circle${INTERMEDIATE_SHAPE}`).each(($point) => {
                expectClose($point.attr('r'), (initialPointRadius * initialGeometry.scale) / scale);
            });
            cy.get(MASK_OUTLINE).then(($outline) => {
                expectClose(
                    $outline.attr('stroke-width'),
                    (initialStrokeWidth * initialGeometry.scale) / scale,
                );
            });
        });

        cy.window().then((win) => {
            requireToolsControlComponent(win).props.canvasInstance.fit();
        }).should((win) => {
            const { scale } = requireToolsControlComponent(win).props.canvasInstance.geometry;
            expect(scale).not.to.equal(zoomedGeometry.scale);
        }).then((win) => {
            fittedOffset = requireToolsControlComponent(win).props.canvasInstance.geometry.offset;
        });
        cy.get(`rect${INTERMEDIATE_SHAPE}`).then(($rectangle) => {
            expectClose($rectangle.attr('x'), fittedOffset + 10);
            expect($rectangle.attr('stroke')).to.equal('#1890ff');
        });
        cy.get(`image${INTERMEDIATE_SHAPE}`).then(($mask) => {
            expectClose($mask.attr('x'), fittedOffset + 150);
        });
        cy.window().then((win) => {
            const tools = requireToolsControlComponent(win);
            tools.props.canvasInstance.interact({
                enabled: true,
                command: 'put_shapes',
                payload: {
                    shapes: [{ shapeType: 'polygon', points: [20, 20, 50, 20, 35, 50] }],
                },
            });
        });
        cy.get(INTERMEDIATE_SHAPE).should('have.length', 1);
        cy.get(`polygon${INTERMEDIATE_SHAPE}`).should('have.length', 1);
        cy.get(MASK_OUTLINE).should('not.exist');
        cy.window().then((win) => {
            const { revokeObjectURL } = win.URL;
            expect(revokeObjectURL.callCount).to.be.greaterThan(initialMaskRevocations);
            clearTemporaryShapes(win);
        });
        cy.get(INTERMEDIATE_SHAPE).should('not.exist');
        cy.get(MASK_OUTLINE).should('not.exist');
    });

    it('keeps defaults local and preserves legacy threshold and Enter request contracts', () => {
        openDetectorsWithModels([detector]);
        readTaskDetectorMetadata().then(({ labelIds, attributeSpecIds }) => {
            const requests = [];
            cy.intercept('POST', '**/api/lambda/functions/test-detector-preview**', (request) => {
                requests.push(request.body);
                request.reply({
                    statusCode: 200,
                    body: [1, 4].includes(requests.length) ?
                        makePreviewResponse(labelIds, attributeSpecIds) : emptyResponse(),
                });
            }).as('detectorCall');

            cy.get(`${PREVIEW_CHECKBOX} input`).should('be.checked').and('be.enabled');
            cy.get(`${LEGACY_THRESHOLD} input`).should('be.disabled');
            cy.get(POSTPROCESSING_METHOD).should('contain.text', 'NMS');
            cy.get(POSTPROCESSING_METRIC).should('contain.text', 'IoS');
            cy.get(`${POSTPROCESSING_THRESHOLD} input`).should('have.value', '0.70');

            cy.get(RUN_BUTTON).click();
            cy.wait('@detectorCall');
            cy.then(() => {
                expect(requests[0].threshold).to.equal(0.1);
                assertUIOnlyOptionsAreOmitted(requests[0]);
            });
            cy.get(PREVIEW).should('contain.text', '4 / 5 results');
            cy.get(PREVIEW_DONE).should('be.enabled');
            cy.get(PREVIEW_CANCEL).click();
            reopenDetectorPopover();

            cy.get(PREVIEW_CHECKBOX).click();
            cy.get(`${PREVIEW_CHECKBOX} input`).should('not.be.checked');
            typeNumericInput(LEGACY_THRESHOLD, '');
            cy.get(RUN_BUTTON).click();
            cy.wait('@detectorCall');
            cy.then(() => {
                expect(requests[1]).not.to.have.property('threshold');
                assertUIOnlyOptionsAreOmitted(requests[1]);
            });

            typeNumericInput(LEGACY_THRESHOLD, '0.62');
            cy.get(RUN_BUTTON).click();
            cy.wait('@detectorCall');
            cy.then(() => {
                expect(requests[2].threshold).to.equal(0.62);
                assertUIOnlyOptionsAreOmitted(requests[2]);
            });

            cy.get(PREVIEW_CHECKBOX).click();
            cy.get(`${PREVIEW_CHECKBOX} input`).should('be.checked');
            cy.get(`${POSTPROCESSING_THRESHOLD} input`).focus();
            cy.get(`${POSTPROCESSING_THRESHOLD} input`).type('{enter}');
            cy.wait('@detectorCall');
            cy.get(PREVIEW).should('contain.text', '4 / 5 results');
            cy.then(() => {
                expect(requests).to.have.length(4);
                expect(requests[3].threshold).to.equal(0.1);
                assertUIOnlyOptionsAreOmitted(requests[3]);
            });
            cy.get(PREVIEW_CANCEL).click();
            reopenDetectorPopover();

            cy.get(POSTPROCESSING_METHOD).click();
            cy.get(`${POSTPROCESSING_METHOD} input`).focus();
            cy.get(`${POSTPROCESSING_METHOD} input`).type('{downarrow}{enter}', { force: true });
            cy.get(POSTPROCESSING_METHOD).should('contain.text', 'NMM');
            cy.wait(100);
            cy.then(() => expect(requests).to.have.length(4));
        });
    });

    it('keeps postprocessing independent, validates overlap boundaries, and supports immediate creation', () => {
        openDetectorsWithModels([detector]);
        readTaskDetectorMetadata().then(({ labelIds, attributeSpecIds }) => {
            selectPostprocessingMethod('Disabled');
            cy.get(`${PREVIEW_CHECKBOX} input`).should('be.checked').and('be.enabled');
            cy.get(POSTPROCESSING_METRIC).should('have.class', 'ant-select-disabled');
            cy.get(`${POSTPROCESSING_THRESHOLD} input`).should('be.disabled');

            ['NMS', 'NMM', 'NMM (greedy)'].forEach((method) => {
                selectPostprocessingMethod(method);
                cy.get(POSTPROCESSING_METRIC).should('not.have.class', 'ant-select-disabled');
                cy.get(`${POSTPROCESSING_THRESHOLD} input`).should('be.enabled');
            });
            selectPostprocessingMethod('NMS');

            typeNumericInput(POSTPROCESSING_THRESHOLD, '');
            cy.get(POSTPROCESSING_ERROR).should('be.visible');
            cy.get(RUN_BUTTON).should('be.disabled');
            ['0', '1', '0.70'].forEach((value) => {
                typeNumericInput(POSTPROCESSING_THRESHOLD, value);
                cy.get(POSTPROCESSING_ERROR).should('not.exist');
                cy.get(RUN_BUTTON).should('be.enabled');
            });

            typeNumericInput(POSTPROCESSING_THRESHOLD, '');
            cy.get(POSTPROCESSING_ERROR).should('be.visible');
            selectPostprocessingMethod('Disabled');
            cy.get(RUN_BUTTON).should('be.enabled');
            cy.get(POSTPROCESSING_METRIC).should('have.class', 'ant-select-disabled');
            cy.get(`${POSTPROCESSING_THRESHOLD} input`).should('be.disabled');

            selectPostprocessingMethod('NMS');
            typeNumericInput(POSTPROCESSING_THRESHOLD, '0.70');
            cy.get(PREVIEW_CHECKBOX).click();
            typeNumericInput(LEGACY_THRESHOLD, '');
            recordSidebarItemIds().then((sidebarIds) => {
                cy.intercept('POST', '**/api/lambda/functions/test-detector-preview**', (request) => {
                    expect(request.body).not.to.have.property('threshold');
                    assertUIOnlyOptionsAreOmitted(request.body);
                    request.reply({
                        statusCode: 200,
                        body: makePreviewResponse(labelIds, attributeSpecIds),
                    });
                }).as('immediateDetectorCall');
                cy.get(RUN_BUTTON).click();
                cy.wait('@immediateDetectorCall');
                cy.get(PREVIEW).should('not.exist');
                expectSidebarCount(sidebarIds.length + 5);
            });
        });
    });

    it('filters an immutable preview, commits once, and preserves confidence in UI and API', () => {
        openDetectorsWithModels([detector]);
        readTaskDetectorMetadata().then(({ labelIds, attributeSpecIds }) => {
            let requestCount = 0;
            recordSidebarItemIds().then((sidebarIds) => {
                cy.intercept('POST', '**/api/lambda/functions/test-detector-preview**', (request) => {
                    requestCount++;
                    expect(request.body.threshold).to.equal(0.1);
                    assertUIOnlyOptionsAreOmitted(request.body);
                    request.reply({
                        statusCode: 200,
                        body: makePreviewResponse(labelIds, attributeSpecIds),
                    });
                }).as('previewTransactionCall');

                cy.get(RUN_BUTTON).click();
                cy.wait('@previewTransactionCall');
                expectSidebarCount(sidebarIds.length);
                cy.get(PREVIEW).should('contain.text', '4 / 5 results');
                cy.get(INTERMEDIATE_SHAPE).should('have.length', 4);
                setPreviewConfidenceAboveEighty();
                cy.then(() => expect(requestCount).to.equal(1));
                cy.get(INTERMEDIATE_SHAPE).should('have.length', 2);
                cy.get(PREVIEW_CANCEL).click();
                expectSidebarCount(sidebarIds.length);
                cy.get(PREVIEW).should('not.exist');
                cy.get(INTERMEDIATE_SHAPE).should('not.exist');
                reopenDetectorPopover();

                cy.get(RUN_BUTTON).click();
                cy.wait('@previewTransactionCall');
                setPreviewConfidenceAboveEighty();
                cy.then(() => expect(requestCount).to.equal(2));
                cy.get(PREVIEW_DONE).click();
                expectSidebarCount(sidebarIds.length + 3);
                cy.get(PREVIEW).should('not.exist');
                cy.get(INTERMEDIATE_SHAPE).should('not.exist');

                cy.get('body').find(SIDEBAR_ITEM).then(($items) => {
                    const newItems = [...$items].filter(({ id }) => !sidebarIds.includes(id));
                    expect(newItems).to.have.length(3);
                    const scoredMask = newItems.find((item) => item.textContent.includes('MASK SHAPE'));
                    expect(scoredMask, 'new scored mask sidebar item').to.exist;
                    cy.wrap(scoredMask).within(() => {
                        cy.contains('.cvat-objects-sidebar-state-item-collapse', 'DETAILS').click();
                        cy.contains('.cvat-object-item-attribute-wrapper', 'model_conf').within(() => {
                            cy.get('.cvat-object-item-text-attribute').should('have.value', '0.9000');
                        });
                    });
                });

                cy.saveJob();
                cy.request(`/api/jobs/${createdJobId}/annotations`).then(({ body }) => {
                    const shape = body.shapes.find(({ score }) => score === 0.9);
                    expect(shape, 'saved 0.90 confidence shape').to.exist;
                    expect(shape.attributes).to.deep.include({
                        spec_id: attributeSpecIds.damage,
                        value: '0.9000',
                    });
                });
                cy.window().then((win) => {
                    const damage = requireToolsControlComponent(win).props.jobInstance.labels
                        .find(({ name }) => name === 'damage');
                    const confidenceAttribute = damage.attributes
                        .find(({ id }) => id === attributeSpecIds.damage);
                    expect(confidenceAttribute.name).to.equal('model_confidence');
                });
            });
        });
    });

    it('rejects a detector result that arrives after navigation to another frame', () => {
        openDetectorsWithModels([detector]);
        readTaskDetectorMetadata().then(({ labelIds, attributeSpecIds }) => {
            let releaseResponse;
            recordSidebarItemIds().then((sidebarIds) => {
                cy.intercept('POST', '**/api/lambda/functions/test-detector-preview**', (request) => (
                    new Cypress.Promise((resolve) => {
                        releaseResponse = () => {
                            request.reply({
                                statusCode: 200,
                                body: makePreviewResponse(labelIds, attributeSpecIds),
                            });
                            resolve();
                        };
                    })
                )).as('delayedDetectorCall');

                cy.get(RUN_BUTTON).click();
                cy.wrap(null).should(() => expect(releaseResponse).to.be.a('function'));
                cy.get('.cvat-player-next-button').click({ force: true });
                cy.get('.cvat-player-frame-selector input[role="spinbutton"]').should('have.value', '1');
                cy.then(() => releaseResponse());
                cy.wait('@delayedDetectorCall');
                cy.get(PREVIEW).should('not.exist');
                cy.get(INTERMEDIATE_SHAPE).should('not.exist');
                cy.get('.cvat-player-previous-button').click();
                cy.get('.cvat-player-frame-selector input[role="spinbutton"]').should('have.value', '0');
                expectSidebarCount(sidebarIds.length);
            });
        });
    });

    it('renders every detector response shape and retains confidence-free lines and points', () => {
        openDetectorsWithModels([detector]);
        readTaskDetectorMetadata().then(({ labelIds }) => {
            let requestCount = 0;
            cy.intercept('POST', '**/api/lambda/functions/test-detector-preview**', (request) => {
                requestCount++;
                request.reply({ statusCode: 200, body: makeAllShapeTypesResponse(labelIds) });
            }).as('allShapeTypesCall');

            cy.get(RUN_BUTTON).click();
            cy.wait('@allShapeTypesCall');
            cy.get(PREVIEW).should('contain.text', '6 / 6 results');
            cy.get(`rect${INTERMEDIATE_SHAPE}`).should('have.length', 1);
            cy.get(`ellipse${INTERMEDIATE_SHAPE}`).should('have.length', 1);
            cy.get(`polygon${INTERMEDIATE_SHAPE}`).should('have.length', 1);
            cy.get(`image${INTERMEDIATE_SHAPE}`).should('have.length', 1);
            cy.get(`polyline${INTERMEDIATE_SHAPE}`).should('have.length', 1);
            cy.get(`circle${INTERMEDIATE_SHAPE}`).should('have.length', 2);

            setPreviewConfidenceToMaximum();
            cy.get(PREVIEW).should('contain.text', '2 / 6 results');
            cy.get(`rect${INTERMEDIATE_SHAPE}`).should('not.exist');
            cy.get(`ellipse${INTERMEDIATE_SHAPE}`).should('not.exist');
            cy.get(`polygon${INTERMEDIATE_SHAPE}`).should('not.exist');
            cy.get(`image${INTERMEDIATE_SHAPE}`).should('not.exist');
            cy.get(`polyline${INTERMEDIATE_SHAPE}`).should('have.length', 1);
            cy.get(`circle${INTERMEDIATE_SHAPE}`).should('have.length', 2);
            cy.then(() => expect(requestCount).to.equal(1));
            cy.get(PREVIEW_CANCEL).click();
        });
    });

    it('fails malformed mask processing safely across retry and cancel', () => {
        openDetectorsWithModels([detector]);
        readTaskDetectorMetadata().then(({ labelIds, attributeSpecIds }) => {
            let requestCount = 0;
            recordSidebarItemIds().then((sidebarIds) => {
                cy.intercept('POST', '**/api/lambda/functions/test-detector-preview**', (request) => {
                    requestCount++;
                    request.reply({
                        statusCode: 200,
                        body: makeMalformedMaskResponse(labelIds, attributeSpecIds),
                    });
                }).as('malformedMaskCall');

                cy.get(RUN_BUTTON).click();
                cy.wait('@malformedMaskCall');
                cy.get(PREVIEW_ERROR).should(
                    'contain.text',
                    'Malformed CVAT mask RLE: counts do not match its bounds',
                );
                cy.get(PREVIEW_RETRY).should('be.visible').and('be.enabled');
                cy.get(PREVIEW_DONE).should('be.disabled');
                expectSidebarCount(sidebarIds.length);
                cy.get(PREVIEW_RETRY).click();
                cy.get(PREVIEW_ERROR).should(
                    'contain.text',
                    'Malformed CVAT mask RLE: counts do not match its bounds',
                );
                cy.get(PREVIEW_DONE).should('be.disabled');
                cy.then(() => expect(requestCount).to.equal(1));
                expectSidebarCount(sidebarIds.length);
                cy.get(PREVIEW_CANCEL).click();
                cy.get(PREVIEW).should('not.exist');
                cy.get(INTERMEDIATE_SHAPE).should('not.exist');
            });
        });
    });
});
