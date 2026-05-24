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

function startInteraction() {
    cy.get('.cvat-tools-interact-button').should('be.visible').click();
}

context('RF-DETR combined interactor', () => {
    const taskName = 'RF-DETR combined interactor task';
    const labelNames = ['bridge_damage', 'bridge_stain'];
    const serverFiles = ['images/image_1.jpg', 'images/image_2.jpg', 'images/image_3.jpg'];
    const envTaskID = Number.parseInt(Cypress.env('taskID'), 10);
    const envJobID = Number.parseInt(Cypress.env('jobID'), 10);
    const useExistingJob = Number.isInteger(envTaskID) && Number.isInteger(envJobID);

    const combinedInteractor = makeInteractorModel({
        id: 'test-rfdetr-combined',
        name: 'Mocked RF-DETR combined interactor',
        labels: ['(A13) danno_urto', '(C5) infiltraz_cls'],
    });

    let createdTaskID = null;

    before(() => {
        cy.visit('/');
        cy.headlessLogin({
            nextURL: useExistingJob ? `/tasks/${envTaskID}/jobs/${envJobID}` : '/tasks',
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

    describe('Combined interactor with mapped labels', () => {
        it('Should show label mapper and create shapes for combined model', () => {
            openInteractorsWithModels([combinedInteractor], 'getCombinedInteractorFunctions');
            selectInteractor(combinedInteractor.id);

            cy.get('.cvat-interactor-label-mapper-wrapper').should('exist');
            cy.get('.cvat-runner-label-mapper').should('exist');

            cy.intercept('POST', '**/api/lambda/functions/test-rfdetr-combined**', (req) => {
                expect(req.body).to.have.property('mapping');

                req.reply({
                    statusCode: 200,
                    body: {
                        shapes: [
                            makeMaskShape({ label: 'bridge_damage', left: 100, top: 100 }),
                            makeMaskShape({ label: 'bridge_stain', left: 200, top: 200 }),
                        ],
                    },
                });
            }).as('combinedInteractorCall');

            startInteraction();
            drawBoxPrompt(100, 100, 300, 300);

            cy.wait('@combinedInteractorCall');
            finishInteraction();

            cy.get('.cvat-objects-sidebar-state-item').should('have.length', 2);
            cy.get('.cvat-objects-sidebar-state-item').first().should('contain', 'bridge_damage');
            cy.get('.cvat-objects-sidebar-state-item').last().should('contain', 'bridge_stain');
        });
    });
});
