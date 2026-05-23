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

function selectInteractor(interactorID) {
    cy.window().then((win) => {
        const toolsControlComponent = requireToolsControlComponent(win);
        toolsControlComponent.setActiveInteractor(interactorID);
    });
    cy.window().should((win) => {
        const toolsControlComponent = requireToolsControlComponent(win);
        const { activeInteractor } = toolsControlComponent.state;
        expect(activeInteractor && activeInteractor.id).to.equal(interactorID);
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

context('Crop instance segmentation interactor', () => {
    const taskName = 'Multiclass crop interactor task';
    const labelNames = ['car', 'person', 'bicycle'];
    const serverFiles = ['images/image_1.jpg', 'images/image_2.jpg', 'images/image_3.jpg'];
    const envTaskID = Number.parseInt(Cypress.env('taskID'), 10);
    const envJobID = Number.parseInt(Cypress.env('jobID'), 10);
    const useExistingJob = Number.isInteger(envTaskID) && Number.isInteger(envJobID);

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

    let createdTaskID = null;

    before(() => {
        cy.visit('/auth/login');
        cy.login();

        if (useExistingJob) {
            cy.visit(`/tasks/${envTaskID}/jobs/${envJobID}`);
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
            createdTaskID = taskResponse.taskID;
            cy.visit(`/tasks/${taskResponse.taskID}/jobs/${taskResponse.jobIDs[0]}`);
            cy.get('.cvat-canvas-container').should('exist');
        });
    });

    after(() => {
        if (createdTaskID !== null) {
            cy.headlessDeleteTask(createdTaskID);
        }

        cy.headlessLogout();
    });

    describe('Mapped multiclass crop interactor', () => {
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
    });

    describe('Edge case: unresolvable labels', () => {
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

    describe('Legacy SAM3 fallback behavior', () => {
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

    describe('Fast interactor switching', () => {
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
