// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

/// <reference types="cypress" />

const CLEAN_MODE_INDICATOR = '.cvat-clean-image-mode-indicator';
const OPERATION_WARNING = 'Finish or cancel the current canvas operation before entering clean-image mode.';
const SHORTCUT_NAME = 'Toggle clean image mode';
const RENDERER_ROOTS = [
    '#cvat_canvas_text_content',
    '#cvat_canvas_masks_content',
    '#cvat_canvas_bitmap',
    '#cvat_canvas_grid',
    '#cvat_canvas_attachment_board',
];
const CLEAN_MODE_OVERLAYS = [
    '.cvat-canvas-frame-tags',
    '.cvat-frame-tag',
    '.cvat-conflict-label',
    '.cvat-canvas-context-menu',
    '.cvat-canvas-point-context-menu',
];

function assertRendererRootsHidden() {
    cy.get('#cvat_canvas_content').should('be.visible').and('have.class', 'cvat_canvas_clean_image');
    cy.get('#cvat_canvas_content > :not(.cvat_canvas_zoom_selection)').should('not.be.visible');
    for (const selector of RENDERER_ROOTS) {
        cy.get(selector)
            .should('exist')
            .and('have.css', 'visibility', 'hidden')
            .and('not.be.visible');
    }
}

function assertRendererRootsRestored() {
    cy.get('#cvat_canvas_content').should('be.visible').and('not.have.class', 'cvat_canvas_clean_image');
    for (const selector of RENDERER_ROOTS) {
        cy.get(selector).should('exist').and('have.css', 'visibility', 'visible');
    }
}

function assertCleanModeOverlaysAbsent() {
    cy.get('body').then(($body) => {
        $body.find('.cvat-hidden-issue-label, .cvat-issue-dialog, .cvat-create-issue-dialog').each((_, dialog) => {
            cy.wrap(dialog).should('not.be.visible');
        });
    });
    for (const selector of CLEAN_MODE_OVERLAYS) {
        cy.get(selector).should('not.exist');
    }

    cy.get('.cvat_canvas_issue_region').should('not.exist');
}

function findShortcutAcrossHelpPages(target) {
    cy.get('.cvat-shortcuts-modal-window-table').should('exist').and('be.visible');
    cy.get('.cvat-shortcuts-modal-window-table').then(($table) => {
        if ($table.text().includes(target)) {
            cy.contains('.cvat-shortcuts-modal-window-table', target).should('be.visible');
            return;
        }

        cy.get('.cvat-shortcuts-modal-window .ant-pagination-item-active')
            .invoke('text')
            .then(Number)
            .then((currentPage) => {
                cy.get('.cvat-shortcuts-modal-window .ant-pagination-next button').then(($button) => {
                    if ($button.is(':disabled') || $button.hasClass('ant-pagination-disabled')) {
                        throw new Error(`"${target}" is missing from the shortcuts help dialog.`);
                    }

                    cy.wrap($button).click();
                    cy.get('.cvat-shortcuts-modal-window .ant-pagination-item-active')
                        .should('have.text', String(currentPage + 1));
                    findShortcutAcrossHelpPages(target);
                });
            });
    });
}

function rememberNewestShape(alias, expectedShapeCount) {
    cy.get('.cvat_canvas_shape').should('have.length', expectedShapeCount).then(($shapes) => {
        const clientIds = [...$shapes].map((shape) => Number(shape.id.match(/\d+$/)[0]));
        return Math.max(...clientIds);
    }).as(alias);
}

function getShape(alias) {
    return cy.get(alias).then((clientId) => cy.get(`#cvat_canvas_shape_${clientId}`));
}

function startRectangleDrawing(labelName) {
    cy.interactControlButton('draw-rectangle');
    cy.switchLabel(labelName, 'draw-rectangle');
    cy.get('.cvat-draw-rectangle-popover').within(() => {
        cy.contains('.ant-radio-wrapper', 'By 2 Points').click();
        cy.contains('button', 'Shape').click();
    });
    cy.get('.cvat-draw-rectangle-control')
        .should('have.class', 'cvat-active-canvas-control');
    cy.get('.cvat_canvas_shape_drawing').should('exist');
}

function switchToStandardWorkspace() {
    cy.get('.cvat-workspace-selector .ant-select-selection-item').then(($selected) => {
        if ($selected.text().trim() !== 'Standard') {
            cy.changeWorkspace('Standard');
        }
    });
    cy.get('.cvat-workspace-selector .ant-select-selection-item').should('have.text', 'Standard');
    cy.window().then((win) => {
        if (win.document.activeElement instanceof win.HTMLElement) {
            win.document.activeElement.blur();
        }
    });
}

context('Clean image mode', { scrollBehavior: false }, () => {
    const taskName = 'Clean image mode browser coverage';
    const labelName = 'clean image object';
    const issueDescription = 'Clean image mode issue';
    const serverFiles = ['images/image_1.jpg', 'images/image_2.jpg'];
    const rectangle = {
        points: 'By 2 Points',
        type: 'Shape',
        labelName,
        firstX: 250,
        firstY: 250,
        secondX: 350,
        secondY: 350,
    };
    const polygon = {
        type: 'Shape',
        labelName,
        pointsMap: [
            { x: 450, y: 250 },
            { x: 550, y: 250 },
            { x: 500, y: 350 },
        ],
        complete: true,
        numberOfPoints: null,
    };
    const mask = [{
        method: 'brush',
        coordinates: [[650, 250], [750, 250], [750, 350], [650, 350], [650, 250]],
    }];

    let taskId = null;
    let jobId = null;
    let originalClientSettings = null;

    before(() => {
        cy.visit('/');
        cy.headlessLogin({ nextURL: '/tasks' });
        cy.window().then((win) => {
            originalClientSettings = win.localStorage.getItem('clientSettings');
        });

        cy.headlessCreateTask({
            labels: [{ name: labelName, attributes: [], type: 'any' }],
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
        }).then((response) => {
            taskId = response.taskId;
            [jobId] = response.jobIds;
            cy.headlessUpdateJob(jobId, { stage: 'validation', state: 'in progress' });
        });
    });

    beforeEach(() => {
        cy.intercept('GET', `/api/jobs/${jobId}/annotations*`).as('jobAnnotations');
        cy.visit(`/tasks/${taskId}/jobs/${jobId}`);
        cy.wait('@jobAnnotations');
        cy.get('.cvat-canvas-container').should('exist').and('be.visible');
        cy.get('.cvat-spinner').should('not.exist');
        cy.get('#cvat_canvas_background').should('be.visible');
        cy.checkFrameNum(0);
        cy.get(CLEAN_MODE_INDICATOR).should('be.visible').and('have.attr', 'aria-pressed', 'false');
    });

    afterEach(() => {
        cy.get('body').then(($body) => {
            if ($body.find(`${CLEAN_MODE_INDICATOR}[aria-pressed="true"]`).length) {
                cy.get(CLEAN_MODE_INDICATOR).click();
            }
            if ($body.find('.cvat_canvas_shape_drawing').length) {
                cy.realPress('Escape');
            }
        });
    });

    after(() => {
        cy.window().then((win) => {
            if (originalClientSettings === null) {
                win.localStorage.removeItem('clientSettings');
            } else {
                win.localStorage.setItem('clientSettings', originalClientSettings);
            }

            expect(win.localStorage.getItem('clientSettings')).to.equal(originalClientSettings);
        });

        cy.headlessLogout();
        if (taskId !== null) {
            cy.task('getAuthHeaders').then((headers) => {
                cy.request({ method: 'DELETE', url: `/api/tasks/${taskId}`, headers });
            });
        }
    });

    it('hides annotation and review UI across frames, then restores each prior visibility state', () => {
        switchToStandardWorkspace();

        cy.createRectangle(rectangle);
        rememberNewestShape('rectangleClientID', 1);

        cy.createPolygon(polygon);
        rememberNewestShape('polygonClientID', 2);
        getShape('@polygonClientID').should('be.visible');

        cy.startMaskDrawing();
        cy.drawMask(mask);
        cy.finishMaskDrawing();
        rememberNewestShape('maskClientID', 3);

        cy.createTag(labelName);
        cy.get('.cvat-frame-tag').should('have.length', 1).and('be.visible');
        cy.saveJob();

        cy.get('@polygonClientID').then((clientId) => {
            cy.get(`#cvat-objects-sidebar-state-item-${clientId}`).within(() => {
                cy.get('.cvat-object-item-button-hidden').click();
                cy.get('.cvat-object-item-button-hidden')
                    .should('have.class', 'cvat-object-item-button-hidden-enabled');
            });
        });
        getShape('@polygonClientID')
            .should('have.class', 'cvat_canvas_hidden')
            .and('not.be.visible');

        cy.changeWorkspace('Review');
        cy.get('@rectangleClientID').then((clientId) => {
            cy.createIssueFromObject(clientId, 'Open an issue ...', issueDescription);
        });
        cy.changeWorkspace('Standard');

        cy.get('#cvat_canvas_background').should('be.visible');
        getShape('@rectangleClientID').should('be.visible');
        getShape('@maskClientID').should('be.visible');
        cy.contains('.cvat-frame-tag', labelName).should('be.visible');
        cy.contains('.cvat-hidden-issue-label', issueDescription).should('be.visible');
        cy.get('.cvat_canvas_issue_region').should('be.visible');

        cy.get('@rectangleClientID').then((clientId) => {
            cy.get(`#cvat_canvas_shape_${clientId}`).trigger('mousemove');
            cy.get(`#cvat_canvas_shape_${clientId}`).rightclick();
        });
        cy.get('.cvat-canvas-context-menu').should('be.visible');

        cy.realPress(['Shift', 'H']);
        cy.get(CLEAN_MODE_INDICATOR).should('be.visible').and('have.attr', 'aria-pressed', 'true');
        cy.get('#cvat_canvas_background')
            .should('be.visible')
            .and('have.css', 'visibility', 'visible');
        assertRendererRootsHidden();
        assertCleanModeOverlaysAbsent();

        // This fixture has no ground-truth job; this browser case only checks conflict UI absence.
        // Populated mapping, hiding, and restoration are exercised in tests/unit/clean-image-mode.cjs.
        cy.goToNextFrame(1);
        cy.get(CLEAN_MODE_INDICATOR).should('be.visible');
        cy.get('#cvat_canvas_background').should('be.visible');
        assertRendererRootsHidden();

        cy.goToPreviousFrame(0);
        cy.get(CLEAN_MODE_INDICATOR).should('be.visible');
        assertRendererRootsHidden();

        cy.realPress(['Shift', 'H']);
        cy.get(CLEAN_MODE_INDICATOR).should('have.attr', 'aria-pressed', 'false');
        assertRendererRootsRestored();
        getShape('@rectangleClientID').should('be.visible');
        getShape('@maskClientID').should('be.visible');
        getShape('@polygonClientID')
            .should('have.class', 'cvat_canvas_hidden')
            .and('not.be.visible');
        cy.contains('.cvat-frame-tag', labelName).should('be.visible');
        cy.contains('.cvat-hidden-issue-label', issueDescription).should('be.visible');
        cy.get('.cvat_canvas_issue_region').should('be.visible');
    });

    it('keeps clean mode active during a real ROI drag and zooms the source image', () => {
        switchToStandardWorkspace();
        cy.realPress(['Shift', 'H']);
        cy.get(CLEAN_MODE_INDICATOR).should('be.visible');
        cy.get('.cvat-resize-control').click();
        cy.get('.cvat-resize-control').should('have.class', 'cvat-active-canvas-control');
        cy.get('#cvat_canvas_background').then(($background) => {
            const before = $background[0].getBoundingClientRect();
            cy.get('#cvat_canvas_wrapper').then(($wrapper) => {
                const bounds = $wrapper[0].getBoundingClientRect();
                const start = { x: bounds.width * 0.35, y: bounds.height * 0.35 };
                const end = { x: bounds.width * 0.6, y: bounds.height * 0.6 };
                cy.wrap($wrapper).realMouseMove(start.x, start.y);
                cy.wrap($wrapper).realMouseDown({ position: start, button: 'left' });
                cy.wrap($wrapper).realMouseMove(end.x, end.y);
                cy.get('.cvat_canvas_zoom_selection').should('be.visible');
                cy.get(CLEAN_MODE_INDICATOR).should('be.visible');
                cy.wrap($wrapper).realMouseUp({ position: end, button: 'left' });
            });
            cy.get('#cvat_canvas_background').should(($after) => {
                expect($after[0].getBoundingClientRect().width).to.be.greaterThan(before.width);
            });
        });
        cy.get('.cvat_canvas_zoom_selection').should('not.exist');
        cy.get(CLEAN_MODE_INDICATOR).should('be.visible');
        assertRendererRootsHidden();
        assertCleanModeOverlaysAbsent();
        cy.get('.cvat-resize-control').click();
        cy.realPress(['Shift', 'H']);
        assertRendererRootsRestored();
    });

    it('rejects activation without cancelling an active rectangle drawing operation', () => {
        switchToStandardWorkspace();
        startRectangleDrawing(labelName);

        cy.realPress(['Shift', 'H']);

        cy.get(CLEAN_MODE_INDICATOR).should('have.attr', 'aria-pressed', 'false').click();
        cy.get(CLEAN_MODE_INDICATOR).should('have.attr', 'aria-pressed', 'false');
        cy.contains('.ant-notification-notice-message', OPERATION_WARNING)
            .should('be.visible')
            .and('have.text', OPERATION_WARNING);
        cy.get('.cvat-draw-rectangle-control')
            .should('have.class', 'cvat-active-canvas-control');
        cy.get('.cvat_canvas_shape_drawing').should('exist');

        cy.realPress('Escape');
        cy.get('.cvat_canvas_shape_drawing').should('not.exist');
        cy.get('.cvat-draw-rectangle-control')
            .should('not.have.class', 'cvat-active-canvas-control');
    });

    it('exits clean mode before a drawing command becomes active', () => {
        switchToStandardWorkspace();
        cy.realPress(['Shift', 'H']);
        cy.get(CLEAN_MODE_INDICATOR).should('be.visible');

        startRectangleDrawing(labelName);

        cy.get(CLEAN_MODE_INDICATOR).should('have.attr', 'aria-pressed', 'false');
        assertRendererRootsRestored();
        cy.get('.cvat-draw-rectangle-control')
            .should('have.class', 'cvat-active-canvas-control');
        cy.get('.cvat_canvas_shape_drawing').should('exist');

        cy.realPress('Escape');
        cy.get('.cvat_canvas_shape_drawing').should('not.exist');
    });

    it('lists the action and honors a shortcut rebound through the settings UI', () => {
        switchToStandardWorkspace();

        cy.realPress('F1');
        cy.get('.cvat-shortcuts-modal-window').should('exist').and('be.visible');
        findShortcutAcrossHelpPages(SHORTCUT_NAME);
        cy.contains('.cvat-shortcuts-modal-window [type="button"]', 'OK').click();
        cy.get('.cvat-shortcuts-modal-window').should('not.be.visible');

        cy.openSettings();
        cy.contains('.cvat-settings-tabs [role="tab"]', 'Shortcuts').click();
        cy.get('.cvat-shortcuts-settings-search input').type(SHORTCUT_NAME);

        cy.contains('.cvat-shortcuts-settings-collapse-item', SHORTCUT_NAME)
            .should('be.visible')
            .as('cleanModeShortcutRow');
        cy.get('@cleanModeShortcutRow').within(() => {
            cy.contains('.cvat-shortcuts-settings-item-title', SHORTCUT_NAME).should('be.visible');
            cy.get('.cvat-shortcuts-settings-select .ant-select-selection-item-remove').click();
            cy.get('.cvat-shortcuts-settings-select .ant-select-selection-item').should('not.exist');
            cy.get('.cvat-shortcuts-settings-select').click();
        });
        cy.realPress(['Alt', 'H']);
        cy.get('@cleanModeShortcutRow')
            .find('.cvat-shortcuts-settings-select .ant-select-selection-item')
            .should('have.text', 'alt+h');
        cy.closeSettings();

        cy.reload();
        cy.get('.cvat-canvas-container').should('exist').and('be.visible');
        cy.realPress(['Shift', 'H']);
        cy.get(CLEAN_MODE_INDICATOR).should('have.attr', 'aria-pressed', 'false');

        cy.realPress(['Alt', 'H']);
        cy.get(CLEAN_MODE_INDICATOR).should('be.visible').realHover();
        cy.contains('.ant-tooltip-inner', '[Alt+H] to restore').should('be.visible');

        cy.realPress(['Alt', 'H']);
        cy.get(CLEAN_MODE_INDICATOR).should('have.attr', 'aria-pressed', 'false');
    });

    it('enters and exits clean mode through the persistent button', () => {
        switchToStandardWorkspace();
        cy.get(CLEAN_MODE_INDICATOR)
            .should('be.visible')
            .and('have.attr', 'aria-pressed', 'false')
            .click();
        cy.get(CLEAN_MODE_INDICATOR).should('have.attr', 'aria-pressed', 'true');
        assertRendererRootsHidden();

        cy.get(CLEAN_MODE_INDICATOR).click();
        cy.get(CLEAN_MODE_INDICATOR).should('have.attr', 'aria-pressed', 'false');
        assertRendererRootsRestored();
    });
});
