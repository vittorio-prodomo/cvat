// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

/// <reference types="cypress" />

const INTERMEDIATE_SHAPE = '.cvat_canvas_interact_intermediate_shape';
const MASK_OUTLINE = '.cvat_canvas_interact_mask_outline';
const detector = {
    id: 'test-detector-preview',
    name: 'Mock detector preview',
    kind: 'detector',
    description: 'Mock detector preview',
    version: 2,
    labels_v2: [{
        name: 'damage',
        type: 'mask',
        attributes: [{ name: 'model_confidence', input_type: 'text', values: [] }],
    }],
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
    cy.intercept('HEAD', '**/api/lambda/functions**', { statusCode: 200 }).as('previewModelsHead');
    cy.intercept('GET', '**/api/lambda/functions**', { statusCode: 200, body: models }).as('previewModels');
    cy.reload();
    cy.wait('@previewModelsHead');
    cy.wait('@previewModels');
    cy.get('.cvat-canvas-container').should('exist');
    cy.get('.cvat-tools-control').should('exist').click();
    cy.get('.cvat-tools-control-popover:visible').within(() => {
        cy.contains('.ant-tabs-tab', 'Detectors').click();
        cy.contains('.ant-row', 'Model:').find('.ant-select').click();
    });
    cy.get('.ant-select-dropdown:visible').contains('.ant-select-item-option-content', models[0].name).click();
}

function makePreviewResponse(taskLabelIds, taskAttributeSpecIds) {
    return {
        tags: [{
            label_id: taskLabelIds.damage,
            frame: 0,
            group: 0,
            source: 'auto',
            attributes: [],
        }],
        tracks: [],
        shapes: [
            {
                label_id: taskLabelIds.damage,
                frame: 0,
                group: 0,
                source: 'auto',
                type: 'mask',
                points: [0, 100, 10, 10, 19, 19],
                score: 0.90,
                occluded: false,
                outside: false,
                rotation: 0,
                z_order: 0,
                attributes: [{ spec_id: taskAttributeSpecIds.damage, value: '0.9000' }],
                elements: [],
            },
            {
                label_id: taskLabelIds.damage,
                frame: 0,
                group: 0,
                source: 'auto',
                type: 'mask',
                points: [0, 36, 12, 12, 17, 17],
                score: 0.30,
                occluded: false,
                outside: false,
                rotation: 0,
                z_order: 0,
                attributes: [{ spec_id: taskAttributeSpecIds.damage, value: '0.3000' }],
                elements: [],
            },
        ],
    };
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

    before(() => {
        cy.visit('/');
        cy.headlessLogin({ nextURL: '/tasks' });
        cy.headlessCreateTask({
            labels: [{
                name: 'damage',
                type: 'any',
                attributes: [{
                    name: 'model_confidence',
                    mutable: false,
                    input_type: 'text',
                    default_value: '',
                    values: [],
                }],
            }],
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
            cy.visit(`/tasks/${taskResponse.taskId}/jobs/${taskResponse.jobIds[0]}`);
            cy.get('.cvat-canvas-container').should('exist');
        });
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

        cy.viewport(1000, 700);
        cy.window().then((win) => {
            requireToolsControlComponent(win).props.canvasInstance.fitCanvas();
        }).should((win) => {
            const { offset } = requireToolsControlComponent(win).props.canvasInstance.geometry;
            expect(offset).not.to.equal(initialGeometry.offset);
        }).then((win) => {
            const tools = requireToolsControlComponent(win);
            const { offset } = tools.props.canvasInstance.geometry;
            cy.get(`rect${INTERMEDIATE_SHAPE}`).then(($rectangle) => {
                expectClose($rectangle.attr('x'), offset + 10);
                expect($rectangle.attr('stroke')).to.equal('#1890ff');
            });
            cy.get(`image${INTERMEDIATE_SHAPE}`).then(($mask) => {
                expectClose($mask.attr('x'), offset + 150);
            });

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

    it('holds mapped detector results until the preview transaction is accepted', () => {
        const taskLabelIds = {};
        const taskAttributeSpecIds = {};
        openDetectorsWithModels([detector]);
        cy.window().then((win) => {
            const damage = requireToolsControlComponent(win).props.jobInstance.labels
                .find(({ name }) => name === 'damage');
            taskLabelIds.damage = damage.id;
            taskAttributeSpecIds.damage = damage.attributes
                .find(({ name }) => name === 'model_confidence').id;
        });

        cy.get('.cvat-detector-preview-confidence-checkbox input').should('be.checked');
        cy.get('.cvat-detector-confidence-threshold input').should('be.disabled');
        cy.get('.cvat-detector-postprocessing-method').should('contain', 'NMS');
        cy.get('.cvat-detector-postprocessing-metric').should('contain', 'IoS');
        cy.get('.cvat-detector-postprocessing-threshold input').should('have.value', '0.70');

        cy.intercept('POST', '**/api/lambda/functions/test-detector-preview**', (request) => {
            expect(request.body.threshold).to.equal(0.1);
            expect(request.body).not.to.have.property('cleanup');
            expect(request.body).not.to.have.property('postprocessing');
            expect(request.body).not.to.have.property('previewConfidence');
            request.reply({
                statusCode: 200,
                body: makePreviewResponse(taskLabelIds, taskAttributeSpecIds),
            });
        }).as('previewCall');
        cy.contains('button', 'Annotate').click();
        cy.wait('@previewCall');
        cy.get('.cvat-objects-sidebar-state-item').should('not.exist');
        cy.get('.cvat-detector-preview-wrapper').should('contain', '1 / 2 results');
        cy.get(INTERMEDIATE_SHAPE).should('have.length', 1);
        cy.get('.cvat-detector-preview-cancel').click();
        cy.get('.cvat-detector-preview-wrapper').should('not.exist');
        cy.get(INTERMEDIATE_SHAPE).should('not.exist');
        cy.get('.cvat-objects-sidebar-state-item').should('not.exist');
    });
});
