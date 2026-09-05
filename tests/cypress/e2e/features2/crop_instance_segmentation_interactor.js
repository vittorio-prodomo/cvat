// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

/// <reference types="cypress" />

function makeInteractorModel({
    id,
    name,
    labels,
    startWithBox = true,
    minPosPoints = 0,
    minNegPoints = 0,
    startWithBoxOptional = false,
    extraParamsSchema = [],
}) {
    return {
        id,
        name,
        kind: 'interactor',
        description: name,
        version: 2,
        labels_v2: labels.map((label) => ({ name: label, type: 'mask' })),
        min_pos_points: minPosPoints,
        min_neg_points: minNegPoints,
        startswith_box: startWithBox,
        startswith_box_optional: startWithBoxOptional,
        extra_params_schema: extraParamsSchema,
    };
}

function makeMaskShape({
    label,
    left,
    top,
    width = 2,
    height = 2,
}) {
    const right = left + width - 1;
    const bottom = top + height - 1;

    return {
        type: 'mask',
        ...(label ? { label } : {}),
        points: [0, width * height, left, top, right, bottom],
        group: 0,
        source: 'semi-auto',
        attributes: [],
        occluded: false,
        rotation: 0,
    };
}

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

function dispatchCanvasMouseDown(win, target, x, y) {
    target.dispatchEvent(new win.MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        view: win,
        button: 0,
        buttons: 1,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
    }));
}

function dispatchCanvasPointerMove(win, x, y) {
    win.dispatchEvent(new win.PointerEvent('pointermove', {
        bubbles: true,
        cancelable: true,
        view: win,
        button: 0,
        buttons: 1,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
    }));
}

function drawBoxPrompt(startX, startY, endX, endY) {
    cy.window().then((win) => {
        const canvasContent = win.document.querySelector('#cvat_canvas_content');
        if (!canvasContent) {
            throw new Error('Missing #cvat_canvas_content');
        }

        dispatchCanvasMouseDown(win, canvasContent, startX, startY);
        dispatchCanvasPointerMove(win, endX, endY);
        dispatchCanvasMouseDown(win, canvasContent, endX, endY);
    });
}

function drawPointPrompt(x, y) {
    cy.window().then((win) => {
        const canvasContent = win.document.querySelector('#cvat_canvas_content');
        if (!canvasContent) {
            throw new Error('Missing #cvat_canvas_content');
        }

        dispatchCanvasMouseDown(win, canvasContent, x, y);
    });
}

function finishInteraction() {
    cy.window().should((win) => {
        const toolsControlComponent = requireToolsControlComponent(win);

        expect(toolsControlComponent.state.interactorResponseReceived).to.equal(true);
    }).then((win) => {
        const canvasWrapper = win.document.querySelector('#cvat_canvas_wrapper');
        if (!canvasWrapper) {
            throw new Error('Missing #cvat_canvas_wrapper');
        }

        canvasWrapper.dispatchEvent(new win.CustomEvent('canvas.interacted', {
            bubbles: true,
            detail: {
                shapes: [],
                finished: true,
            },
        }));
    });
}

function openInteractorsWithModels(models, alias) {
    const headAlias = `${alias}Head`;

    cy.intercept('HEAD', '**/api/lambda/functions**', {
        statusCode: 200,
    }).as(headAlias);
    cy.intercept('GET', '**/api/lambda/functions**', {
        statusCode: 200,
        body: models,
    }).as(alias);

    cy.reload();
    cy.wait(`@${headAlias}`);
    cy.wait(`@${alias}`);
    cy.get('.cvat-canvas-container').should('exist');
    cy.get('.cvat-tools-control').should('exist').click();
    cy.get('.cvat-tools-control-popover').should('be.visible').within(() => {
        cy.contains('.ant-tabs-tab', 'Interactors').click();
    });
    cy.window().should((win) => {
        const toolsControlComponent = requireToolsControlComponent(win);

        expect(toolsControlComponent.props.interactors).to.have.length(models.length);
    });
}

function selectInteractor(interactorId) {
    cy.window().then((win) => {
        const toolsControlComponent = requireToolsControlComponent(win);
        toolsControlComponent.setActiveInteractor(interactorId);
    });
    cy.window().should((win) => {
        const toolsControlComponent = requireToolsControlComponent(win);
        const { activeInteractor } = toolsControlComponent.state;
        expect(activeInteractor && activeInteractor.id).to.equal(interactorId);
    });
}

function selectTaskLabel(labelName) {
    cy.window().then((win) => {
        const toolsControlComponent = requireToolsControlComponent(win);
        const label = toolsControlComponent.props.labels.find(
            (_label) => _label.name === labelName,
        );

        if (!label) {
            throw new Error(`Missing task label ${labelName}`);
        }

        toolsControlComponent.setState({ activeLabelID: label.id });
    });
    cy.window().should((win) => {
        const toolsControlComponent = requireToolsControlComponent(win);
        const activeLabel = toolsControlComponent.props.labels.find(
            (_label) => _label.id === toolsControlComponent.state.activeLabelID,
        );

        expect(activeLabel && activeLabel.name).to.equal(labelName);
    });
}

function startInteraction() {
    cy.get('.cvat-tools-interact-button').should('be.visible').click();
}

function measureToolsLayout() {
    return cy.get('.cvat-tools-control-popover')
        .filter(':visible')
        .first()
        .find('.cvat-tools-control-popover-content')
        .should('be.visible')
        .then(($content) => {
            const content = $content[0];
            const roi = content.querySelector('.cvat-automatic-annotation-region-of-interest-container');
            const inputs = ['xtl', 'ytl', 'width', 'height'].map((name) => {
                const input = roi && roi.querySelector(`input[name="${name}"]`);
                return input && (input.closest('.ant-input-number') || input);
            });
            const buttons = roi ? Array.from(roi.querySelectorAll('button')) : [];
            const clearButton = buttons.find((buttonElement) => buttonElement.textContent.trim() === 'Clear');
            const drawButton = buttons.find((buttonElement) => buttonElement !== clearButton);
            const controls = [...inputs, drawButton, clearButton];

            expect(roi, 'ROI controls').to.exist;
            controls.forEach((control) => expect(control, 'ROI row control').to.exist);
            const [firstTop] = controls.map((control) => control.getBoundingClientRect().top);
            controls.forEach((control) => {
                expect(Math.abs(control.getBoundingClientRect().top - firstTop)).to.be.at.most(2);
            });

            const rect = content.getBoundingClientRect();
            return {
                width: rect.width,
                height: rect.height,
                clientWidth: content.clientWidth,
                scrollWidth: content.scrollWidth,
            };
        });
}

context('Crop instance segmentation interactor', () => {
    const taskName = 'Multiclass crop interactor task';
    const labelNames = ['car', 'person', 'bicycle'];
    const serverFiles = ['images/image_1.jpg', 'images/image_2.jpg', 'images/image_3.jpg'];
    const envTaskId = Number.parseInt(Cypress.env('taskID'), 10);
    const envJobId = Number.parseInt(Cypress.env('jobID'), 10);
    const useExistingJob = Number.isInteger(envTaskId) && Number.isInteger(envJobId);
    const fallbackContractOnly = Cypress.env('fallbackContractOnly') === true;
    const scenarios = fallbackContractOnly ? describe.skip : describe;
    let fallbackCreateTaskCalls = 0;
    let fallbackDeleteTaskCalls = 0;

    if (fallbackContractOnly) {
        Cypress.Commands.overwrite('headlessCreateTask', () => {
            fallbackCreateTaskCalls++;
            return cy.wrap({ taskId: 166, jobIds: [182] });
        });
        Cypress.Commands.overwrite('headlessDeleteTask', (_originalCommand, taskId) => {
            expect(taskId).to.equal(166);
            fallbackDeleteTaskCalls++;
            return cy.wrap(null);
        });
    }

    const mappedCropInteractor = makeInteractorModel({
        id: 'test-crop-interactor',
        name: 'Mocked crop instance segmentation interactor',
        labels: ['car', 'person', 'bicycle'],
    });
    const invalidLabelInteractor = makeInteractorModel({
        id: 'test-crop-interactor-invalid',
        name: 'Mocked crop interactor with invalid labels',
        labels: ['car', 'person'],
    });
    const legacyInteractor = makeInteractorModel({
        id: 'test-sam3-interactor',
        name: 'Mocked SAM3 interactor',
        labels: [],
        startWithBox: false,
        minPosPoints: 1,
    });
    const conceptInteractor = makeInteractorModel({
        id: 'test-sam3-concept-interactor',
        name: 'Mocked concept-capable SAM3 interactor',
        labels: [],
        startWithBox: false,
        startWithBoxOptional: true,
        extraParamsSchema: [{
            name: 'text_prompt',
            type: 'text',
            label: 'Text prompt',
            default: '',
            max_length: 256,
            supports_mask_refinement: true,
            supports_concept_box: true,
        }],
    });
    const compactOptionalBoxInteractor = makeInteractorModel({
        id: 'test-compact-optional-box-interactor',
        name: 'Mocked compact optional-box interactor',
        labels: [],
        startWithBox: false,
        startWithBoxOptional: true,
        minPosPoints: 1,
    });
    const interactorA = makeInteractorModel({
        id: 'interactor-a',
        name: 'Interactor A',
        labels: ['dog', 'cat'],
    });
    const interactorB = makeInteractorModel({
        id: 'interactor-b',
        name: 'Interactor B',
        labels: ['car', 'person'],
    });

    let createdTaskId = null;

    before(() => {
        if (fallbackContractOnly) {
            cy.intercept('POST', '**/api/tasks**', () => {
                throw new Error('Fallback contract regression attempted to create a real task');
            });
            cy.intercept('DELETE', '**/api/tasks**', () => {
                throw new Error('Fallback contract regression attempted to delete a real task');
            });
        }

        cy.visit('/');
        cy.headlessLogin({
            nextURL: useExistingJob ? `/tasks/${envTaskId}/jobs/${envJobId}` : '/tasks',
        });

        if (useExistingJob) {
            cy.get('.cvat-canvas-container').should('exist');
            return;
        }

        cy.headlessCreateTask({
            labels: labelNames.map((name) => ({ name, attributes: [], type: 'any' })),
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

    after(() => {
        if (createdTaskId !== null) {
            cy.headlessDeleteTask(createdTaskId).then(() => {
                if (fallbackContractOnly) {
                    expect(fallbackDeleteTaskCalls).to.equal(1);
                }
            });
        }

        cy.headlessLogout();
    });

    if (fallbackContractOnly) {
        it('Uses the shared task response contract without task API writes', () => {
            expect(fallbackCreateTaskCalls).to.equal(1);
            cy.location('pathname').should('eq', '/tasks/166/jobs/182');
            cy.get('.cvat-canvas-container').should('exist');
        });
    }

    scenarios('Mapped multiclass crop interactor', () => {
        it('Should show label mapper for mapped multiclass interactors', () => {
            openInteractorsWithModels([mappedCropInteractor], 'getLambdaFunctions');
            selectInteractor(mappedCropInteractor.id);

            cy.get('.cvat-interactor-label-mapper-wrapper').should('exist');
            cy.get('.cvat-runner-label-mapper').should('exist');
        });

        it('Should create labeled shapes for default auto-mapping', () => {
            openInteractorsWithModels([mappedCropInteractor], 'getMappedInteractorFunctions');
            selectInteractor(mappedCropInteractor.id);
            cy.window().should((win) => {
                const toolsControlComponent = requireToolsControlComponent(win);

                expect(toolsControlComponent.state.interactorMapping).to.have.property('car');
                expect(toolsControlComponent.state.interactorMapping).to.have.property('person');
            });

            cy.intercept('POST', '**/api/lambda/functions/test-crop-interactor**', (req) => {
                expect(req.body).to.have.property('mapping');
                expect(req.body.mapping).to.have.property('car');
                expect(req.body.mapping).to.have.property('person');

                req.reply({
                    statusCode: 200,
                    body: {
                        shapes: [
                            makeMaskShape({ label: 'car', left: 100, top: 100 }),
                            makeMaskShape({ label: 'person', left: 200, top: 200 }),
                        ],
                    },
                });
            }).as('cropInteractorCall');

            startInteraction();
            cy.window().should((win) => {
                const toolsControlComponent = requireToolsControlComponent(win);

                expect(toolsControlComponent.state.interactorMapping).to.have.property('car');
                expect(toolsControlComponent.state.interactorMapping).to.have.property('person');
            });
            drawBoxPrompt(100, 100, 300, 300);

            cy.wait('@cropInteractorCall');
            finishInteraction();

            cy.get('.cvat-objects-sidebar-state-item').should('have.length', 2);
            cy.get('.cvat-objects-sidebar-state-item').first().should('contain', 'car');
            cy.get('.cvat-objects-sidebar-state-item').last().should('contain', 'person');
        });

        it('Should preserve deleted auto-mapped rows and send the edited mapping', () => {
            openInteractorsWithModels([mappedCropInteractor], 'getEditableMappingFunctions');
            selectInteractor(mappedCropInteractor.id);

            cy.contains('.cvat-runner-label-mapping-row', 'person').within(() => {
                cy.get('.cvat-danger-circle-icon').click();
            });

            cy.contains('.cvat-runner-label-mapping-row', 'person').should('not.exist');

            cy.intercept('POST', '**/api/lambda/functions/test-crop-interactor**', (req) => {
                expect(req.body.mapping).to.have.property('car');
                expect(req.body.mapping).to.have.property('bicycle');
                expect(req.body.mapping).to.not.have.property('person');

                req.reply({
                    statusCode: 200,
                    body: {
                        shapes: [
                            makeMaskShape({ label: 'car', left: 100, top: 100 }),
                        ],
                    },
                });
            }).as('editedMappingCall');

            startInteraction();
            drawBoxPrompt(100, 100, 300, 300);

            cy.wait('@editedMappingCall');
            finishInteraction();

            cy.get('.cvat-objects-sidebar-state-item').should('have.length', 1);
            cy.get('.cvat-objects-sidebar-state-item').should('contain', 'car');
        });

        it('Should keep an empty edited mapping empty after deleting every auto-mapped row', () => {
            openInteractorsWithModels([mappedCropInteractor], 'getEmptyEditedMappingFunctions');
            selectInteractor(mappedCropInteractor.id);

            ['car', 'person', 'bicycle'].forEach((labelName) => {
                cy.contains('.cvat-runner-label-mapping-row', labelName).within(() => {
                    cy.get('.cvat-danger-circle-icon').click();
                });
            });

            cy.window().should((win) => {
                const toolsControlComponent = requireToolsControlComponent(win);

                expect(toolsControlComponent.state.interactorMapping).to.deep.equal({});
            });

            cy.intercept('POST', '**/api/lambda/functions/test-crop-interactor**', (req) => {
                expect(req.body).to.have.property('mapping');
                expect(req.body.mapping).to.deep.equal({});

                req.reply({
                    statusCode: 200,
                    body: {
                        shapes: [],
                    },
                });
            }).as('emptyEditedMappingCall');

            startInteraction();
            cy.window().should((win) => {
                const toolsControlComponent = requireToolsControlComponent(win);

                expect(toolsControlComponent.state.interactorMapping).to.deep.equal({});
            });
            drawBoxPrompt(100, 100, 300, 300);

            cy.wait('@emptyEditedMappingCall');
        });
    });

    scenarios('Edge case: unresolvable labels', () => {
        it('Should skip shapes with unresolvable labels and show warning', () => {
            openInteractorsWithModels([invalidLabelInteractor], 'getInvalidLabelFunctions');
            selectInteractor(invalidLabelInteractor.id);

            cy.intercept('POST', '**/api/lambda/functions/test-crop-interactor-invalid**', {
                statusCode: 200,
                body: {
                    shapes: [
                        makeMaskShape({ label: 'car', left: 100, top: 100 }),
                        makeMaskShape({ label: 'nonexistent_label', left: 200, top: 200 }),
                    ],
                },
            }).as('invalidLabelCall');

            startInteraction();
            drawBoxPrompt(100, 100, 300, 300);

            cy.wait('@invalidLabelCall');
            finishInteraction();

            cy.get('.ant-notification-notice-warning').should('exist');
            cy.get('.ant-notification-notice-message').should('contain', 'Some shapes were skipped');
            cy.get('.ant-notification-notice-description').should('contain', 'could not be resolved');
            cy.get('.cvat-objects-sidebar-state-item').should('have.length', 1);
            cy.get('.cvat-objects-sidebar-state-item').should('contain', 'car');
        });
    });

    scenarios('Legacy SAM3 fallback behavior', () => {
        it('Should use active label for interactors without per-shape labels', () => {
            openInteractorsWithModels([legacyInteractor], 'getLegacyFunctions');
            selectInteractor(legacyInteractor.id);

            cy.get('.cvat-interactor-label-mapper-wrapper').should('not.exist');
            selectTaskLabel('car');

            cy.intercept('POST', '**/api/lambda/functions/test-sam3-interactor**', {
                statusCode: 200,
                body: {
                    shapes: [
                        makeMaskShape({ left: 150, top: 150 }),
                    ],
                },
            }).as('sam3InteractorCall');

            startInteraction();
            drawPointPrompt(200, 200);

            cy.wait('@sam3InteractorCall');
            finishInteraction();

            cy.get('.cvat-objects-sidebar-state-item').should('have.length', 1);
            cy.get('.cvat-objects-sidebar-state-item').should('contain', 'car');
        });
    });

    scenarios('AI Tools interactor layout', () => {
        it('Keeps concept modes stable, overflow-free, and the ROI controls on one row', () => {
            cy.viewport(1280, 900);
            openInteractorsWithModels([
                conceptInteractor,
                compactOptionalBoxInteractor,
            ], 'getConceptLayoutFunctions');
            selectInteractor(conceptInteractor.id);

            cy.get('.cvat-tools-interactor-mode-controls')
                .should('have.class', 'cvat-tools-interactor-mode-controls-concept-capable');

            let singleObjectLayout;
            measureToolsLayout().then((layout) => {
                singleObjectLayout = layout;
                expect(layout.scrollWidth).to.be.at.most(layout.clientWidth);
            });

            cy.contains('[aria-label="SAM3 task mode"] .ant-radio-button-wrapper', 'Find similar objects')
                .click();
            cy.get('.cvat-tools-interactor-concept-controls').should('be.visible');
            cy.get('.cvat-tools-interactor-mode-controls')
                .should('have.class', 'cvat-tools-interactor-mode-controls-concept-capable');

            measureToolsLayout().then((conceptLayout) => {
                expect(conceptLayout.scrollWidth).to.be.at.most(conceptLayout.clientWidth);
                expect(Math.abs(conceptLayout.width - singleObjectLayout.width)).to.be.at.most(2);
                expect(Math.abs(conceptLayout.height - singleObjectLayout.height)).to.be.at.most(2);
            });

            selectInteractor(compactOptionalBoxInteractor.id);
            cy.get('.cvat-tools-interactor-mode-controls')
                .should('not.have.class', 'cvat-tools-interactor-mode-controls-concept-capable');
        });
    });

    scenarios('Fast interactor switching', () => {
        it('Should not send stale mapping when switching interactors', () => {
            openInteractorsWithModels([interactorA, interactorB], 'getSwitchingFunctions');

            selectInteractor(interactorA.id);
            cy.get('.cvat-interactor-label-mapper-wrapper').should('exist');

            selectInteractor(interactorB.id);

            cy.intercept('POST', '**/api/lambda/functions/interactor-b**', (req) => {
                if (req.body.mapping) {
                    expect(req.body.mapping).to.not.have.property('dog');
                    expect(req.body.mapping).to.not.have.property('cat');
                }

                req.reply({
                    statusCode: 200,
                    body: {
                        shapes: [
                            makeMaskShape({ label: 'car', left: 100, top: 100 }),
                        ],
                    },
                });
            }).as('interactorBCall');

            startInteraction();
            drawBoxPrompt(100, 100, 300, 300);

            cy.wait('@interactorBCall');
            finishInteraction();

            cy.get('.cvat-objects-sidebar-state-item').should('have.length', 1);
            cy.get('.cvat-objects-sidebar-state-item').should('contain', 'car');
        });
    });
});
