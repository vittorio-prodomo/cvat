// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

/// <reference types="cypress" />

context('Crop instance segmentation interactor', () => {
    const taskName = 'Multiclass crop interactor task';
    const labelNames = ['car', 'person', 'bicycle'];
    const serverFiles = ['images/image_1.jpg', 'images/image_2.jpg', 'images/image_3.jpg'];

    before(() => {
        cy.visit('/auth/login');
        cy.login();

        // Create task with multiple labels
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
            cy.visit(`/tasks/${taskResponse.taskID}/jobs/${taskResponse.jobID}`);
            cy.get('.cvat-canvas-container').should('exist');
        });
    });

    after(() => {
        cy.logout();
        cy.getAuthKey().then((authKey) => {
            cy.deleteTask(authKey, taskName);
        });
    });

    describe('Mapped multiclass crop interactor', () => {
        it('Should show label mapper for mapped multiclass interactors', () => {
            // Mock a crop-based interactor with labels_v2
            cy.intercept('GET', '/api/lambda/functions*', {
                statusCode: 200,
                body: {
                    results: [
                        {
                            id: 'test-crop-interactor',
                            kind: 'interactor',
                            description: 'Mocked crop instance segmentation interactor',
                            version: 2,
                            labels_v2: [
                                { name: 'car', type: 'mask' },
                                { name: 'person', type: 'mask' },
                                { name: 'bicycle', type: 'mask' },
                            ],
                            params: {
                                canvas: {
                                    startWithBox: true,
                                    minPosVertices: 0,
                                    minNegVertices: 0,
                                },
                            },
                        },
                    ],
                },
            }).as('getLambdaFunctions');

            // Open AI tools
            cy.get('.cvat-tools-control').click();
            cy.wait('@getLambdaFunctions');

            // Switch to interaction mode
            cy.get('.cvat-tools-control-popover').within(() => {
                cy.contains('Interaction').click();
            });

            // Verify label mapper is visible
            cy.get('.cvat-interactor-label-mapper-wrapper').should('exist');
            cy.get('.cvat-label-mapper-label-select').should('have.length.at.least', 3);

            // Select interactor
            cy.get('.cvat-interactor-selector').click();
            cy.contains('[role="option"]', 'Mocked crop instance segmentation interactor').click();

            // Verify active label block is hidden for mapped interactor
            cy.get('.cvat-label-item-selector').should('not.exist');
        });

        it('Should send mapping in interactor request and create labeled shapes', () => {
            let requestBody;

            // Mock interactor response with per-shape labels
            cy.intercept('POST', '/api/lambda/functions/test-crop-interactor', (req) => {
                requestBody = req.body;

                // Verify mapping is sent
                expect(requestBody).to.have.property('mapping');
                expect(requestBody.mapping).to.have.property('car');
                expect(requestBody.mapping).to.have.property('person');

                req.reply({
                    statusCode: 200,
                    body: {
                        shapes: [
                            {
                                type: 'mask',
                                label: 'car',
                                points: [0, 0, 10, 10, 100, 100, 0, 99],
                                group: 0,
                                source: 'semi-auto',
                                attributes: [],
                                occluded: false,
                                rotation: 0,
                            },
                            {
                                type: 'mask',
                                label: 'person',
                                points: [0, 0, 20, 20, 200, 200, 0, 199],
                                group: 0,
                                source: 'semi-auto',
                                attributes: [],
                                occluded: false,
                                rotation: 0,
                            },
                        ],
                    },
                });
            }).as('cropInteractorCall');

            // Draw a box to trigger interaction
            cy.get('.cvat-canvas-container').trigger('mousedown', 100, 100, { button: 0 });
            cy.get('.cvat-canvas-container').trigger('mousemove', 300, 300);
            cy.get('.cvat-canvas-container').trigger('mouseup', 300, 300);

            // Wait for interactor call
            cy.wait('@cropInteractorCall');

            // Accept shapes by pressing N (or trigger finished event)
            cy.get('body').type('n');

            // Verify shapes were created with correct labels
            cy.get('.cvat-objects-sidebar-state-item').should('have.length', 2);
            cy.get('.cvat-objects-sidebar-state-item').first().should('contain', 'car');
            cy.get('.cvat-objects-sidebar-state-item').last().should('contain', 'person');
        });
    });

    describe('Edge case: unresolvable labels', () => {
        it('Should skip shapes with unresolvable labels and show warning', () => {
            // Mock interactor with valid response but invalid label names
            cy.intercept('GET', '/api/lambda/functions*', {
                statusCode: 200,
                body: {
                    results: [
                        {
                            id: 'test-crop-interactor-invalid',
                            kind: 'interactor',
                            description: 'Mocked crop interactor with invalid labels',
                            version: 2,
                            labels_v2: [
                                { name: 'car', type: 'mask' },
                                { name: 'person', type: 'mask' },
                            ],
                            params: {
                                canvas: {
                                    startWithBox: true,
                                    minPosVertices: 0,
                                    minNegVertices: 0,
                                },
                            },
                        },
                    ],
                },
            }).as('getInvalidLabelFunctions');

            // Reload to pick up new mock
            cy.reload();
            cy.get('.cvat-canvas-container').should('exist');

            // Open AI tools
            cy.get('.cvat-tools-control').click();
            cy.wait('@getInvalidLabelFunctions');

            // Switch to interaction mode
            cy.get('.cvat-tools-control-popover').within(() => {
                cy.contains('Interaction').click();
            });

            // Select interactor
            cy.get('.cvat-interactor-selector').click();
            cy.contains('[role="option"]', 'Mocked crop interactor with invalid labels').click();

            // Mock interactor response with one valid and one invalid label
            cy.intercept('POST', '/api/lambda/functions/test-crop-interactor-invalid', {
                statusCode: 200,
                body: {
                    shapes: [
                        {
                            type: 'mask',
                            label: 'car', // Valid label
                            points: [0, 0, 10, 10, 100, 100, 0, 99],
                            group: 0,
                            source: 'semi-auto',
                            attributes: [],
                            occluded: false,
                            rotation: 0,
                        },
                        {
                            type: 'mask',
                            label: 'nonexistent_label', // Invalid label
                            points: [0, 0, 20, 20, 200, 200, 0, 199],
                            group: 0,
                            source: 'semi-auto',
                            attributes: [],
                            occluded: false,
                            rotation: 0,
                        },
                    ],
                },
            }).as('invalidLabelCall');

            // Draw a box to trigger interaction
            cy.get('.cvat-canvas-container').trigger('mousedown', 100, 100, { button: 0 });
            cy.get('.cvat-canvas-container').trigger('mousemove', 300, 300);
            cy.get('.cvat-canvas-container').trigger('mouseup', 300, 300);

            // Wait for interactor call
            cy.wait('@invalidLabelCall');

            // Accept shapes by pressing N
            cy.get('body').type('n');

            // Verify warning notification appears
            cy.get('.ant-notification-notice-warning').should('exist');
            cy.get('.ant-notification-notice-message').should('contain', 'Some shapes were skipped');
            cy.get('.ant-notification-notice-description').should('contain', 'could not be resolved');

            // Verify only the valid shape was created
            cy.get('.cvat-objects-sidebar-state-item').should('have.length', 1);
            cy.get('.cvat-objects-sidebar-state-item').should('contain', 'car');
        });
    });

    describe('Legacy SAM3 fallback behavior', () => {
        it('Should use active label for interactors without per-shape labels', () => {
            // Mock legacy SAM3-style interactor without labels_v2
            cy.intercept('GET', '/api/lambda/functions*', {
                statusCode: 200,
                body: {
                    results: [
                        {
                            id: 'test-sam3-interactor',
                            kind: 'interactor',
                            description: 'Mocked SAM3 interactor',
                            version: 2,
                            labels_v2: [],
                            params: {
                                canvas: {
                                    startWithBox: false,
                                    minPosVertices: 1,
                                    minNegVertices: 0,
                                },
                            },
                        },
                    ],
                },
            }).as('getLegacyFunctions');

            // Reload to pick up new mock
            cy.reload();
            cy.get('.cvat-canvas-container').should('exist');

            // Open AI tools
            cy.get('.cvat-tools-control').click();
            cy.wait('@getLegacyFunctions');

            // Switch to interaction mode
            cy.get('.cvat-tools-control-popover').within(() => {
                cy.contains('Interaction').click();
            });

            // Verify label mapper is NOT visible
            cy.get('.cvat-interactor-label-mapper-wrapper').should('not.exist');

            // Verify active label selector IS visible
            cy.get('.cvat-label-item-selector').should('exist');

            // Select active label
            cy.get('.cvat-label-item-selector').click();
            cy.contains('[role="option"]', 'car').click();

            // Select interactor
            cy.get('.cvat-interactor-selector').click();
            cy.contains('[role="option"]', 'Mocked SAM3 interactor').click();

            // Mock interactor response WITHOUT per-shape labels
            cy.intercept('POST', '/api/lambda/functions/test-sam3-interactor', {
                statusCode: 200,
                body: {
                    shapes: [
                        {
                            type: 'mask',
                            // No label field
                            points: [0, 0, 15, 15, 150, 150, 0, 149],
                            group: 0,
                            source: 'semi-auto',
                            attributes: [],
                            occluded: false,
                            rotation: 0,
                        },
                    ],
                },
            }).as('sam3InteractorCall');

            // Click a point to trigger interaction
            cy.get('.cvat-canvas-container').click(200, 200);

            // Wait for interactor call
            cy.wait('@sam3InteractorCall');

            // Accept shape by pressing N
            cy.get('body').type('n');

            // Verify shape was created with active label 'car'
            cy.get('.cvat-objects-sidebar-state-item').should('contain', 'car');
        });
    });
});
