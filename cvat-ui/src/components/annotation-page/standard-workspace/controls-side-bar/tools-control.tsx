// Copyright (C) 2020-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { ReactPortal } from 'react';
import ReactDOM from 'react-dom';
import { connect } from 'react-redux';
import Icon, {
    EnvironmentFilled,
    EnvironmentOutlined,
    LoadingOutlined,
    QuestionCircleOutlined,
} from '@ant-design/icons';
import Popover from 'antd/lib/popover';
import Select from 'antd/lib/select';
import Button from 'antd/lib/button';
import Modal from 'antd/lib/modal';
import Text from 'antd/lib/typography/Text';
import Tabs from 'antd/lib/tabs';
import { Row, Col } from 'antd/lib/grid';
import notification from 'antd/lib/notification';
import message from 'antd/lib/message';
import Switch from 'antd/lib/switch';
import Radio from 'antd/lib/radio';
import lodash from 'lodash';

import { AIToolsIcon } from 'icons';
import { Canvas, convertShapesForInteractor, InteractionResult } from 'cvat-canvas-wrapper';
import {
    getCore, Label, MLModel, ObjectState, ObjectType, ShapeType, Job,
    MinimalShape, InteractorResults, TrackerResults, DimensionType,
} from 'cvat-core-wrapper';
import openCVWrapper from 'utils/opencv-wrapper/opencv-wrapper';
import primaryActionOnEnter from 'utils/primary-action-enter';
import MaskMorphologyClient from 'utils/mask-morphology-client';
import {
    CombinedState, ActiveControl, ToolsBlockerState, PluginComponent,
} from 'reducers';
import {
    interactWithCanvas,
    switchNavigationBlocked as switchNavigationBlockedAction,
    fetchAnnotationsAsync,
    updateAnnotationsAsync,
    createAnnotationsAsync,
} from 'actions/annotation-actions';
import DetectorRunner, {
    AnnotateTaskRequestBody,
    type RegionOfInterest,
} from 'components/model-runner-modal/detector-runner';
import RegionOfInterestInputComponent from 'components/model-runner-modal/region-of-interest-input';
import LabelSelector from 'components/label-selector/label-selector';
import CVATTooltip from 'components/common/cvat-tooltip';
import CVATMarkdown from 'components/common/cvat-markdown';
import ModelExtraParamsForm, {
    buildExtraParamsDefaults,
    ModelExtraParamSchemaItem,
} from 'components/common/model-extra-params-form';

import ApproximationAccuracy from 'components/annotation-page/standard-workspace/controls-side-bar/approximation-accuracy';
import ConfidenceThreshold from 'components/annotation-page/standard-workspace/controls-side-bar/confidence-threshold';
import { switchToolsBlockerState } from 'actions/settings-actions';
import { ServerMapping } from 'components/model-runner-modal/label-mapping-utils';
import InteractorLabelMapper from './interactor-label-mapper';
import withVisibilityHandling from './handle-popover-visibility';
import ToolsTooltips from './interactor-tooltips';
import TextMaskRefinement from './text-mask-refinement';
import MaskMorphologyControl from './mask-morphology-control';

interface StateToProps {
    canvasInstance: Canvas;
    labels: Label[];
    states: ObjectState[];
    activeLabelID: number | null;
    jobInstance: Job;
    isActivated: boolean;
    frame: number;
    interactors: MLModel[];
    detectors: MLModel[];
    trackers: MLModel[];
    currentZOrder: number;
    defaultApproxPolyAccuracy: number;
    toolsBlockerState: ToolsBlockerState;
    frameData: { width: number; height: number; deleted?: boolean };
    interactorExtras: PluginComponent[];
}

interface DispatchToProps {
    updateAnnotations: (states: ObjectState[]) => Promise<void>;
    createAnnotations: (states: ObjectState[]) => void;
    fetchAnnotations: () => void;
    onInteractionStart: typeof interactWithCanvas;
    onSwitchToolsBlockerState: typeof switchToolsBlockerState;
    switchNavigationBlocked: typeof switchNavigationBlockedAction;
}

const MIN_SUPPORTED_INTERACTOR_VERSION = 2;
const core = getCore();
const CustomPopover = withVisibilityHandling(Popover, 'tools-control');
const startWithBoxStorageItem = 'startInteractingWithBox';

function mapStateToProps(state: CombinedState): StateToProps {
    const {
        annotation: {
            job: { instance: jobInstance, labels },
            canvas: { instance: canvasInstance, activeControl },
            player: {
                frame: { number: frame, data: frameData },
            },
            annotations: {
                zLayer: { cur: currentZOrder },
                states,
            },
            drawing: { activeLabelID },
        },
        models: {
            interactors, detectors, trackers,
        },
        settings: {
            workspace: { toolsBlockerState, defaultApproxPolyAccuracy },
        },
        plugins: {
            components: {
                aiTools: {
                    interactors: {
                        extras: interactorExtras,
                    },
                },
            },
        },
    } = state;

    return {
        interactors,
        detectors,
        trackers,
        isActivated: activeControl === ActiveControl.AI_TOOLS,
        activeLabelID,
        labels,
        states,
        canvasInstance: canvasInstance as Canvas,
        jobInstance: jobInstance as Job,
        frame,
        currentZOrder,
        defaultApproxPolyAccuracy,
        toolsBlockerState,
        frameData,
        interactorExtras,
    };
}

const mapDispatchToProps = {
    onInteractionStart: interactWithCanvas,
    updateAnnotations: updateAnnotationsAsync,
    createAnnotations: createAnnotationsAsync,
    fetchAnnotations: fetchAnnotationsAsync,
    onSwitchToolsBlockerState: switchToolsBlockerState,
    switchNavigationBlocked: switchNavigationBlockedAction,
};

type Props = StateToProps & DispatchToProps;
interface TrackedShape {
    clientID: number;
    serverlessState: any;
    shapePoints: number[];
    trackerModel: MLModel;
}

interface State {
    activeInteractor: MLModel | null;
    activeLabelID: number | null;
    activeTracker: MLModel | null;
    startInteractingWithBox: boolean;
    convertMasksToPolygons: boolean;
    trackedShapes: TrackedShape[];
    fetching: boolean;
    interactorResponseReceived: boolean;
    showConfidenceControl: boolean;
    approxPolyAccuracy: number;
    thresholdValue: number;
    activeTab: 'detectors' | 'interactors' | 'trackers';
    mode: 'detection' | 'interaction' | 'tracking';
    portals: React.ReactPortal[];
    interactorMapping: ServerMapping | null;
    interactorExtraParams: Record<string, unknown>;
    interactorExtraParamsTouched: Record<string, boolean>;
    interactorPromptMode: 'single_object' | 'concept';
    conceptUsesBox: boolean;
    refiningMask: number | null;
    maskAdjustmentRevision: number;
    allowROI: boolean;
    interactorRegionOfInterest: RegionOfInterest;
    detectorRegionOfInterest: RegionOfInterest;
    toolsPopoverVisible: boolean;
}

type DetectorResults = Extract<
    Awaited<ReturnType<typeof core.lambda.call>>,
    { tags: unknown[]; shapes: unknown[]; tracks: unknown[] }
>;

interface InteractionRequest {
    interactor: MLModel;
    data: {
        frame: number;
        neg_points: number[][];
        pos_points: number[][];
        obj_bbox: number[][];
        roi?: NonNullable<RegionOfInterest>;
    };
    mapping: ServerMapping | null;
    extraParams: Record<string, unknown>;
    refinement?: { index: number; revision: number };
}

function trackedRectangleMapper(shape: MinimalShape): MinimalShape {
    return {
        type: ShapeType.RECTANGLE,
        points: shape.points.reduce(
            (acc: number[], value: number, index: number): number[] => {
                if (index % 2) {
                // y
                    acc[1] = Math.min(acc[1], value);
                    acc[3] = Math.max(acc[3], value);
                } else {
                // x
                    acc[0] = Math.min(acc[0], value);
                    acc[2] = Math.max(acc[2], value);
                }
                return acc;
            },
            [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER],
        ),
    };
}

function registerPlugin(): (callback: null | (() => void)) => void {
    let onTrigger: null | (() => void) = null;
    const listener = {
        name: 'Remove annotations listener',
        description: 'Tracker needs to know when annotations is reset in the job',
        cvat: {
            classes: {
                Job: {
                    prototype: {
                        annotations: {
                            clear: {
                                leave(self: any, result: any) {
                                    if (typeof onTrigger === 'function') {
                                        onTrigger();
                                    }
                                    return result;
                                },
                            },
                        },
                    },
                },
            },
        },
    };

    core.plugins.register(listener);

    return (callback: null | (() => void)) => {
        onTrigger = callback;
    };
}

const onRemoveAnnotations = registerPlugin();

export class ToolsControlComponent extends React.PureComponent<Props, State> {
    private maskAdjustmentClient: MaskMorphologyClient | null = null;
    private maskAdjustments = new Map<number, {
        value: number;
        source: ToolsControlComponent['interaction']['latestResponse'][number];
        preview: ToolsControlComponent['interaction']['latestResponse'][number];
        pending: boolean;
    }>();
    private refinementRevision = 0;
    private refinement: { index: number; seed: ToolsControlComponent['interaction']['latestResponse'][number] } | null = null;
    // Keep N/repeat aligned with the canvas command saved by onInteractionStart,
    // even when the inactive panel has since been edited.
    private lastInteractorSetup: Pick<State,
    'activeInteractor' | 'activeLabelID' | 'interactorPromptMode' | 'conceptUsesBox' | 'interactorExtraParams' |
    'interactorExtraParamsTouched' | 'interactorMapping' | 'interactorRegionOfInterest'> | null = null;

    private interaction: {
        id: string | null;
        isAborted: boolean;
        latestPostponedRequest: InteractionRequest | null;
        latestResponse: {
            rle: Int32Array;
            points: [number, number][];
            contours: [number, number][][];
            approximatedPoints: [number, number][];
            confidence: number;
            labelName: string | null;
            empty?: boolean;
        }[];
        latestRequest: InteractionRequest | null;
        closeFetchingMessage: (() => void) | null;
        noShapesMessage: (() => void) | null;
    };

    public constructor(props: Props) {
        super(props);

        const supportedTrackers = this.getSupportedTrackers();

        const firstInteractor = props.interactors.length ? props.interactors[0] : null;
        const interactorExtraParams = firstInteractor?.extraParamsSchema ?
            buildExtraParamsDefaults(firstInteractor.extraParamsSchema as ModelExtraParamSchemaItem[]) :
            {};

        this.state = {
            convertMasksToPolygons: false,
            startInteractingWithBox: (localStorage.getItem(startWithBoxStorageItem) ?? 'true') === 'true',
            activeInteractor: firstInteractor,
            activeTracker: supportedTrackers.length ? supportedTrackers[0] : null,
            activeLabelID: props.labels.length ? props.labels[0].id as number : null,
            approxPolyAccuracy: props.defaultApproxPolyAccuracy,
            thresholdValue: 0.5,
            trackedShapes: [],
            fetching: false,
            interactorResponseReceived: false,
            showConfidenceControl: false,
            mode: 'interaction',
            activeTab: 'interactors',
            portals: [],
            interactorMapping: null,
            interactorExtraParams,
            interactorExtraParamsTouched: {},
            interactorPromptMode: 'single_object',
            conceptUsesBox: false,
            refiningMask: null,
            maskAdjustmentRevision: 0,
            allowROI: props.jobInstance.dimension === DimensionType.DIMENSION_2D,
            interactorRegionOfInterest: null,
            detectorRegionOfInterest: null,
            toolsPopoverVisible: false,
        };

        this.interaction = {
            id: null,
            isAborted: false,
            latestPostponedRequest: null,
            latestResponse: [],
            latestRequest: null,
            closeFetchingMessage: null,
            noShapesMessage: null,
        };
    }

    public componentDidMount(): void {
        const { canvasInstance } = this.props;
        onRemoveAnnotations(() => {
            this.setState({ trackedShapes: [] });
        });

        this.setState({
            portals: this.collectTrackerPortals(),
        });

        canvasInstance.html().addEventListener('canvas.interacted', this.interactionListener);
        canvasInstance.html().addEventListener('canvas.canceled', this.cancelListener);
    }

    public componentDidUpdate(prevProps: Props, prevState: State): void {
        const {
            isActivated, defaultApproxPolyAccuracy, states, toolsBlockerState, jobInstance,
        } = this.props;
        const {
            approxPolyAccuracy, mode, activeTracker, thresholdValue,
        } = this.state;

        if (isActivated && mode === 'interaction' && this.state.interactorPromptMode === 'concept' &&
            (prevProps.frame !== this.props.frame || prevProps.jobInstance.id !== jobInstance.id)) {
            this.cancelListener();
            this.props.canvasInstance.cancel();
            return;
        }

        if (prevProps.states !== states || prevState.activeTracker !== activeTracker) {
            this.setState({
                portals: this.collectTrackerPortals(),
            });
        }

        if (prevProps.jobInstance.dimension !== jobInstance.dimension) {
            this.setState({
                allowROI: jobInstance.dimension === DimensionType.DIMENSION_2D,
                interactorRegionOfInterest: null,
                detectorRegionOfInterest: null,
            });
        }

        if (prevProps.isActivated && !isActivated) {
            this.cancelListener();
            window.removeEventListener('contextmenu', this.contextmenuDisabler);

            // hide interaction messages if exists
            for (const messageCallback of ['closeFetchingMessage', 'noShapesMessage'] as const) {
                if (this.interaction[messageCallback]) {
                    this.interaction[messageCallback]?.();
                    this.interaction[messageCallback] = null;
                }
            }
        } else if (!prevProps.isActivated && isActivated) {
            this.clearMaskAdjustments();
            this.refinement = null;
            this.refinementRevision++;
            // reset flags when start interaction/tracking
            this.interaction = {
                id: null,
                isAborted: false,
                latestPostponedRequest: null,
                latestResponse: [],
                latestRequest: null,
                closeFetchingMessage: null,
                noShapesMessage: null,
            };

            this.setState((state) => ({
                ...state,
                ...(mode === 'interaction' ? this.lastInteractorSetup : {}),
                approxPolyAccuracy: defaultApproxPolyAccuracy,
                interactorResponseReceived: false,
                showConfidenceControl: false,
                refiningMask: null,
            }), () => {
                if (this.state.mode === 'interaction' && this.state.interactorPromptMode === 'concept' &&
                    this.hasTextPrompting() &&
                    !(this.state.conceptUsesBox && this.supportsConceptPrompting())) {
                    // Activation resets the session above; enqueue only after that reset.
                    this.onInteraction({ detail: { shapes: [] } } as unknown as Event);
                }
            });
            window.addEventListener('contextmenu', this.contextmenuDisabler);
        }

        if (
            prevProps.toolsBlockerState.algorithmsLocked &&
            !toolsBlockerState.algorithmsLocked &&
            isActivated && mode === 'interaction' && this.interaction.latestPostponedRequest
        ) {
            // Ensure interaction id exists before replaying postponed request
            if (!this.interaction.id) {
                this.interaction.id = lodash.uniqueId('interaction_');
            }
            // Replay postponed request with the original interactor/params snapshot
            this.interaction.latestRequest = this.interaction.latestPostponedRequest;
            this.interaction.latestPostponedRequest = null;
            this.runInteractionRequest(this.interaction.id);
        }

        if (prevState.thresholdValue !== thresholdValue) {
            if (isActivated && mode === 'interaction') {
                if (this.refinement && !this.visibleInteractionResults().some(({ index }) => (
                    index === this.refinement?.index
                ))) {
                    this.finishRefinement();
                }
                this.drawIntermediateShapesOnCanvas();
            }
        }

        if (prevState.approxPolyAccuracy !== approxPolyAccuracy) {
            if (isActivated && mode === 'interaction') {
                this.interaction.latestResponse.forEach(({ points }, idx) => {
                    const approximated = this.approximateResponsePoints(points);
                    this.interaction.latestResponse[idx].approximatedPoints = approximated;
                });
                this.maskAdjustments.forEach(({ preview }) => {
                    preview.approximatedPoints = this.approximateResponsePoints(preview.points);
                });

                this.drawIntermediateShapesOnCanvas();
            }
        }

        this.checkTrackedStates(prevProps);
    }

    public componentWillUnmount(): void {
        const { canvasInstance } = this.props;
        this.clearMaskAdjustments();
        onRemoveAnnotations(null);
        canvasInstance.html().removeEventListener('canvas.interacted', this.interactionListener);
        canvasInstance.html().removeEventListener('canvas.canceled', this.cancelListener);
    }

    private getSupportedTrackers(): MLModel[] {
        const { trackers } = this.props;
        return trackers.filter((tracker: MLModel) => tracker.supportedShapeTypes!.includes(ShapeType.RECTANGLE));
    }

    private renderROIControls(): JSX.Element | null {
        const { canvasInstance, frameData } = this.props;

        return (
            <RegionOfInterestInputComponent
                frameWidth={frameData.width}
                frameHeight={frameData.height}
                canvasInstance={canvasInstance}
                onSubmit={(interactorRegionOfInterest) => this.setState({ interactorRegionOfInterest })}
            />
        );
    }

    private renderRegionOfInterestOverlay(): ReactPortal | null {
        const {
            canvasInstance,
            frameData: { width: frameWidth, height: frameHeight },
            isActivated,
        } = this.props;
        const {
            interactorRegionOfInterest, detectorRegionOfInterest, toolsPopoverVisible, mode, activeTab,
        } = this.state;
        const attachmentBoard = window.document.getElementById('cvat_canvas_attachment_board');
        let regionOfInterest = null;
        if ((activeTab === 'interactors' && toolsPopoverVisible) || (isActivated && mode === 'interaction')) {
            regionOfInterest = interactorRegionOfInterest;
        } else if (activeTab === 'detectors' && toolsPopoverVisible) {
            regionOfInterest = detectorRegionOfInterest;
        }

        if (
            !attachmentBoard ||
            !Number.isInteger(frameWidth) ||
            !Number.isInteger(frameHeight) ||
            !regionOfInterest
        ) {
            return null;
        }

        const { offset } = canvasInstance.geometry;
        const overlayWidth = frameWidth + offset * 2;
        const overlayHeight = frameHeight + offset * 2;
        const overlayROI = {
            xtl: regionOfInterest[0] + offset,
            ytl: regionOfInterest[1] + offset,
            xbr: regionOfInterest[2] + offset,
            ybr: regionOfInterest[3] + offset,
        };

        const clipPath = `
            polygon(
                evenodd,
                0 0,
                ${overlayWidth}px 0,
                ${overlayWidth}px ${overlayHeight}px,
                0 ${overlayHeight}px,
                0 0,
                ${overlayROI.xtl}px ${overlayROI.ytl}px,
                ${overlayROI.xbr}px ${overlayROI.ytl}px,
                ${overlayROI.xbr}px ${overlayROI.ybr}px,
                ${overlayROI.xtl}px ${overlayROI.ybr}px,
                ${overlayROI.xtl}px ${overlayROI.ytl}px
            )
        `;

        return ReactDOM.createPortal(
            <div
                className='cvat-automatic-annotation-region-of-interest-overlay'
                style={{
                    width: overlayWidth,
                    height: overlayHeight,
                    clipPath,
                }}
            />,
            attachmentBoard,
        );
    }

    private contextmenuDisabler = (e: MouseEvent): void => {
        if (
            e.target &&
            (e.target as Element).classList &&
            (e.target as Element).classList.toString().includes('ant-modal')
        ) {
            e.preventDefault();
        }
    };

    private cancelListener = async (): Promise<void> => {
        this.clearMaskAdjustments();
        this.refinement = null;
        this.refinementRevision++;
        this.interaction.isAborted = true;
        this.interaction.id = null;
        this.interaction.latestRequest = null;
        this.interaction.latestPostponedRequest = null;
        this.interaction.latestResponse = [];
        for (const callback of ['closeFetchingMessage', 'noShapesMessage'] as const) {
            this.interaction[callback]?.();
            this.interaction[callback] = null;
        }
        this.setState({ fetching: false, interactorResponseReceived: false, refiningMask: null });
    };

    private runInteractionRequest = async (interactionId: string): Promise<void> => {
        const { jobInstance } = this.props;
        const { activeInteractor, fetching } = this.state;

        const { id, latestRequest } = this.interaction;
        if (id !== interactionId || !latestRequest || fetching) {
            // id !== interactionId: request not relevant anymore (new session has started)
            // !latestRequest: nothing to process
            // fetching: another request is already running
            return;
        }

        const {
            interactor, data, mapping, extraParams, refinement,
        } = latestRequest;
        this.interaction.latestRequest = null;

        try {
            this.interaction.closeFetchingMessage = message.loading({
                content: `Waiting for a response from ${activeInteractor?.name}`,
                duration: 0,
                className: 'cvat-tracking-notice',
            });

            try {
                // run server request
                this.setState({ fetching: true });
                await this.initializeOpenCV();
                const response = await core.lambda.call(
                    jobInstance.taskId,
                    interactor,
                    {
                        ...data,
                        type: 'interact',
                        job: jobInstance.id,
                        ...(mapping !== null ? { mapping } : {}),
                        extra_params: extraParams,
                    },
                ) as InteractorResults;

                if (this.interaction.id !== interactionId || this.interaction.isAborted ||
                    !this.props.isActivated || this.props.frame !== data.frame ||
                    this.props.jobInstance.id !== jobInstance.id) {
                    // new interaction session or the session is aborted
                    return;
                }

                if (refinement && refinement.revision !== this.refinementRevision) return;

                const latestResponse: ToolsControlComponent['interaction']['latestResponse'] = [];
                let showConfidenceControl = false;
                for (const item of response.shapes) {
                    if (item.type !== ShapeType.MASK) continue;

                    const points = Int32Array.from(item.points);
                    const contours = this.receiveContoursFromMask(points);
                    const polygonPoints = this.receivePointsFromMask(contours);
                    if (polygonPoints.length < 3) {
                        continue;
                    }

                    const approximated = this.approximateResponsePoints(polygonPoints);
                    const confidenceAttr = item.attributes.find((attr) => attr.spec_id === 0);
                    const confidence = confidenceAttr ? +confidenceAttr.value : 1;
                    showConfidenceControl = showConfidenceControl || !!confidenceAttr;
                    latestResponse.push({
                        rle: points,
                        points: polygonPoints,
                        contours,
                        approximatedPoints: approximated,
                        confidence,
                        labelName: item.label ?? null,
                    });
                }

                if (refinement) {
                    const original = this.interaction.latestResponse[refinement.index];
                    const replacement = latestResponse[0];
                    this.interaction.latestResponse[refinement.index] = replacement ? {
                        ...replacement, confidence: original.confidence, labelName: original.labelName,
                    } : {
                        ...original,
                        empty: true,
                        rle: new Int32Array(),
                        points: [],
                        contours: [],
                        approximatedPoints: [],
                    };
                    showConfidenceControl = this.state.showConfidenceControl;
                    const adjustment = this.maskAdjustments.get(refinement.index);
                    if (adjustment) this.applyMaskAdjustment(refinement.index, adjustment.value);
                } else {
                    this.clearMaskAdjustments();
                    this.interaction.latestResponse = latestResponse;
                }
                this.setState({
                    interactorResponseReceived: !!this.interaction.latestResponse.length,
                    showConfidenceControl,
                });
            } finally {
                if (this.interaction.id === interactionId) {
                    this.interaction.closeFetchingMessage?.();
                    this.interaction.closeFetchingMessage = null;
                    this.setState({ fetching: false }, () => {
                        if (this.interaction.latestRequest) {
                            setTimeout(() => this.runInteractionRequest(interactionId));
                        }
                    });
                }
            }

            this.drawIntermediateShapesOnCanvas();
        } catch (error: any) {
            if (this.interaction.id !== interactionId || this.interaction.isAborted) return;
            if (refinement && refinement.revision !== this.refinementRevision) return;
            notification.error({
                description: <CVATMarkdown>{error.message}</CVATMarkdown>,
                message: 'Interaction error occurred',
                duration: null,
            });
        }
    };

    private onInteraction = (e: Event): void => {
        const { frame, isActivated } = this.props;
        const {
            activeInteractor, interactorExtraParams, interactorMapping, interactorExtraParamsTouched,
            interactorRegionOfInterest, interactorPromptMode, conceptUsesBox,
        } = this.state;

        if (!isActivated) {
            return;
        }

        if (!this.interaction.id) {
            this.interaction.id = lodash.uniqueId('interaction_');
        }

        const { shapes } = (e as CustomEvent).detail;
        const interactor = activeInteractor as MLModel;
        const boxes = convertShapesForInteractor(shapes, 'rectangle', 'positive');
        const posPoints = convertShapesForInteractor(shapes, 'points', 'positive');
        const negPoints = convertShapesForInteractor(shapes, 'points', 'negative');

        const { refinement } = this;
        if (refinement && !posPoints.length && !negPoints.length) {
            this.invalidateRefinementRequests();
            // The approximation setting may have changed while refining this seed.
            refinement.seed.approximatedPoints = this.approximateResponsePoints(refinement.seed.points);
            this.interaction.latestResponse[refinement.index] = refinement.seed;
            const adjustment = this.maskAdjustments.get(refinement.index);
            if (adjustment) this.applyMaskAdjustment(refinement.index, adjustment.value);
            this.drawIntermediateShapesOnCanvas();
            this.setState({ interactorResponseReceived: true });
            return;
        }

        const conceptMode = interactorPromptMode === 'concept' && this.hasTextPrompting();
        const conceptUsesExemplar = conceptMode && conceptUsesBox && this.supportsConceptPrompting();
        if (conceptMode && !refinement) {
            const positiveRectangles = shapes.filter((shape: InteractionResult) => (
                shape.shapeType === 'rectangle' && shape.type === 'positive'
            ));
            if (posPoints.length || negPoints.length ||
                (conceptUsesExemplar ? positiveRectangles.length !== 1 || boxes.length !== 2 : shapes.length > 0)) {
                return;
            }
        }

        // Filter out null/undefined values and untouched schema defaults from extra params snapshot
        const schema = interactor.extraParamsSchema as ModelExtraParamSchemaItem[] | undefined;
        const schemaDefaults = new Map(
            schema?.map((param) => [param.name, param.default]) ?? [],
        );
        const filteredExtraParams = Object.entries(interactorExtraParams).reduce(
            (acc, [key, value]) => {
                if (key === 'text_prompt') {
                    if (conceptMode && !refinement && typeof value === 'string' && value.trim()) {
                        acc[key] = value.trim();
                    }
                    return acc;
                }
                if (value !== null && value !== undefined) {
                    // Include if touched OR if not equal to schema default
                    if (interactorExtraParamsTouched[key] || value !== schemaDefaults.get(key)) {
                        acc[key] = value;
                    }
                }
                return acc;
            },
            {} as Record<string, unknown>,
        );
        if (conceptMode && this.supportsConceptPrompting() && !refinement) {
            filteredExtraParams.prompt_mode = 'concept';
        }
        if (refinement) {
            const seed = Array.from(refinement.seed.rle);
            const [left, top] = interactorRegionOfInterest ?? [0, 0];
            seed[seed.length - 4] -= left;
            seed[seed.length - 3] -= top;
            seed[seed.length - 2] -= left;
            seed[seed.length - 1] -= top;
            filteredExtraParams.refinement_mask = seed;
        }
        const request: InteractionRequest = {
            interactor,
            data: {
                frame,
                obj_bbox: refinement ? [] : boxes,
                pos_points: posPoints,
                neg_points: negPoints,
                ...(interactorRegionOfInterest ? { roi: lodash.cloneDeep(interactorRegionOfInterest) } : {}),
            },
            mapping: lodash.cloneDeep(interactorMapping),
            extraParams: lodash.cloneDeep(filteredExtraParams),
            ...(refinement ? { refinement: { index: refinement.index, revision: ++this.refinementRevision } } : {}),
        };
        if (this.props.toolsBlockerState.algorithmsLocked) {
            this.interaction.latestRequest = null;
            this.interaction.latestPostponedRequest = request;
        } else {
            this.interaction.latestRequest = request;
            this.runInteractionRequest(this.interaction.id);
        }
    };

    private onTracking = async (e: Event): Promise<void> => {
        const { trackedShapes, activeTracker, activeLabelID } = this.state;
        const {
            isActivated, jobInstance, frame, currentZOrder, fetchAnnotations,
        } = this.props;

        if (!isActivated || !activeLabelID || !activeTracker) {
            return;
        }

        const [label] = jobInstance.labels.filter((_label: any): boolean => _label.id === activeLabelID);

        const { finished } = (e as CustomEvent).detail;
        if (!finished) {
            return;
        }

        const { shapes } = (e as CustomEvent<{ shapes: InteractionResult[] | null }>).detail;
        if (!Array.isArray(shapes) || !shapes.length) {
            return;
        }

        try {
            const states = shapes.map(({ points }) => (
                new core.classes.ObjectState({
                    shapeType: ShapeType.RECTANGLE,
                    objectType: ObjectType.TRACK,
                    source: core.enums.Source.SEMI_AUTO,
                    zOrder: currentZOrder,
                    label,
                    points,
                    frame,
                    occluded: false,
                    attributes: {},
                    descriptions: [`Trackable (${activeTracker.name})`],
                })
            ));

            const clientIDs = await jobInstance.annotations.put(states);
            this.setState({
                trackedShapes: [
                    ...trackedShapes,
                    ...clientIDs.map((clientID: number, index: number): TrackedShape => ({
                        clientID,
                        serverlessState: null,
                        shapePoints: states[index].points!,
                        trackerModel: activeTracker,
                    })),
                ],
            });

            // update annotations on a canvas
            fetchAnnotations();
        } catch (error: any) {
            notification.error({
                description: <CVATMarkdown>{error.message}</CVATMarkdown>,
                message: 'Tracking error occurred',
                duration: null,
            });
        }
    };

    private interactionListener = async (e: Event): Promise<void> => {
        const { isActivated, canvasInstance } = this.props;
        const { activeInteractor, mode, interactorRegionOfInterest } = this.state;

        if (!isActivated) {
            return;
        }

        if (mode === 'interaction') {
            if (!activeInteractor) {
                return;
            }

            const { shapes, finished, selectedShape } = (e as CustomEvent<{
                shapes: InteractionResult[]; finished: boolean; selectedShape?: number;
            }>).detail;

            if (finished) {
                if (this.interaction.isAborted) return;
                // make an object from current result
                // do not make one more request
                // prevent future requests if possible
                this.interaction.isAborted = true;
                this.interaction.latestRequest = null;
                this.interaction.latestPostponedRequest = null;
                this.constructFromLatestResponse();
            } else {
                if (this.state.interactorPromptMode === 'concept' && this.hasTextPrompting()) {
                    if (selectedShape !== undefined && !this.refinement) {
                        this.selectRefinementMask(selectedShape);
                    } else if (this.refinement) {
                        this.onInteraction(e);
                    } else if (this.state.conceptUsesBox && this.supportsConceptPrompting()) {
                        const boxes = convertShapesForInteractor(shapes, 'rectangle', 'positive');
                        const posPoints = convertShapesForInteractor(shapes, 'points', 'positive');
                        const negPoints = convertShapesForInteractor(shapes, 'points', 'negative');
                        const positiveRectangles = shapes.filter((shape: InteractionResult) => (
                            shape.shapeType === 'rectangle' && shape.type === 'positive'
                        ));
                        if (positiveRectangles.length === 1 && boxes.length === 2 &&
                            !posPoints.length && !negPoints.length) {
                            this.onInteraction(e);
                        }
                    }
                    return;
                }
                const isRectangleRequired = activeInteractor!.params.canvas.startWithBox === true;
                const minPosPoints = activeInteractor!.params.canvas.minPosVertices ?? 0;
                const minNegPoints = activeInteractor!.params.canvas.minNegVertices ?? 0;

                const boxes = convertShapesForInteractor(shapes, 'rectangle', 'positive');
                const posPoints = convertShapesForInteractor(shapes, 'points', 'positive');
                const negPoints = convertShapesForInteractor(shapes, 'points', 'negative');

                if (isRectangleRequired && !boxes.length) {
                    // there should be at least one box to proceed
                    canvasInstance.interact({
                        enabled: true,
                        command: 'draw_box',
                        settings: {
                            crosshair: true,
                            ...(interactorRegionOfInterest ? { regionOfInterest: interactorRegionOfInterest } : {}),
                        },
                    });
                    return;
                }

                // An optional starting box also permits point refinement (SAM/SAM3),
                // even when a box alone satisfies the minimum prompt requirements.
                const expectsPoints = minPosPoints > 0 || minNegPoints > 0 ||
                    activeInteractor.params.canvas.startWithBoxOptional === true;

                if (expectsPoints && boxes.length > 0) {
                    // auto-switch to points when something is already drawn
                    canvasInstance.interact({
                        enabled: true,
                        command: 'draw_points',
                        settings: {
                            crosshair: false,
                            ...(interactorRegionOfInterest ? {
                                regionOfInterest: interactorRegionOfInterest,
                            } : {}),
                        },
                    });
                }

                if (posPoints.length < minPosPoints || negPoints.length < minNegPoints) {
                    // there should be enough points to proceed
                    return;
                }

                this.onInteraction(e);
            }
        }

        if (mode === 'tracking') {
            this.onTracking(e);
        }
    };

    private setActiveInteractor = (value: string): void => {
        const { interactors } = this.props;
        const { activeInteractor } = this.state;
        const [interactor] = interactors.filter((_interactor: MLModel) => _interactor.id === value);

        if (!interactor || activeInteractor?.id === interactor.id) {
            return;
        }

        if (interactor.version < MIN_SUPPORTED_INTERACTOR_VERSION) {
            notification.warning({
                message: 'Interactor API is outdated',
                description: 'Probably, you should consider updating the serverless function',
            });
        }

        const interactorExtraParams = interactor.extraParamsSchema ?
            buildExtraParamsDefaults(interactor.extraParamsSchema as ModelExtraParamSchemaItem[]) :
            {};

        this.setState({
            activeInteractor: interactor,
            interactorMapping: null,
            interactorExtraParams,
            interactorExtraParamsTouched: {},
            interactorPromptMode: 'single_object',
            conceptUsesBox: false,
        });
    };

    private setActiveTracker = (value: string): void => {
        const { trackers } = this.props;
        this.setState({
            activeTracker: trackers.filter((tracker: MLModel) => tracker.id === value)[0],
        });
    };

    private hasTextPrompting(): boolean {
        return !!this.state.activeInteractor?.extraParamsSchema?.some(
            (param: ModelExtraParamSchemaItem) => param.name === 'text_prompt' && param.type === 'text',
        );
    }

    private supportsConceptPrompting(): boolean {
        return !!this.state.activeInteractor?.extraParamsSchema?.some(
            (param: ModelExtraParamSchemaItem) => param.name === 'text_prompt' &&
                param.type === 'text' && param.supports_concept_box === true,
        );
    }

    private supportsMaskRefinement(): boolean {
        const { activeInteractor, interactorPromptMode } = this.state;
        return interactorPromptMode === 'concept' && this.hasTextPrompting() &&
            !!activeInteractor?.extraParamsSchema?.some(
                (param: ModelExtraParamSchemaItem) => param.name === 'text_prompt' &&
                    param.type === 'text' && param.supports_mask_refinement === true,
            );
    }

    private visibleInteractionResults(): {
        result: ToolsControlComponent['interaction']['latestResponse'][number]; index: number;
    }[] {
        const { thresholdValue } = this.state;
        // Keep raw masks available for selection/reset even when an adjustment
        // or polygon approximation hides their preview. Drawing and Done filter
        // the effective geometry after applying the selected mask's adjustment.
        return this.interaction.latestResponse.map((result, index) => ({ result, index }))
            .filter(({ result }) => !result.empty &&
                (typeof result.confidence !== 'number' || result.confidence >= thresholdValue));
    }

    private invalidateRefinementRequests(): void {
        this.refinementRevision++;
        this.interaction.latestRequest = null;
        this.interaction.latestPostponedRequest = null;
    }

    private clearMaskAdjustments(): void {
        this.maskAdjustments.clear();
        this.maskAdjustmentClient?.dispose();
        this.maskAdjustmentClient = null;
    }

    private displayedMaskResult(
        index: number, raw: ToolsControlComponent['interaction']['latestResponse'][number],
    ): ToolsControlComponent['interaction']['latestResponse'][number] {
        // While a new adjustment is being computed, keep the last confirmed
        // preview. Done must always use the mask that is actually displayed.
        return this.maskAdjustments.get(index)?.preview ?? raw;
    }

    private refreshMaskAdjustments(): void {
        this.setState((state) => ({ maskAdjustmentRevision: state.maskAdjustmentRevision + 1 }));
        this.drawIntermediateShapesOnCanvas();
    }

    private applyMaskAdjustment = async (index: number, value: number): Promise<void> => {
        const source = this.interaction.latestResponse[index];
        if (!source || !this.props.isActivated || this.interaction.isAborted ||
            !Number.isInteger(value) || Math.abs(value) > 20) return;
        if (value === 0) {
            this.maskAdjustments.delete(index);
            this.refreshMaskAdjustments();
            return;
        }

        const entry = {
            value,
            source,
            preview: this.maskAdjustments.get(index)?.preview ?? source,
            pending: source.rle.length > 0,
        };
        this.maskAdjustments.set(index, entry);
        if (!source.rle.length) entry.preview = source;
        this.refreshMaskAdjustments();
        if (!entry.pending) return;
        const session = this.interaction.id;
        const isCurrent = (): boolean => this.interaction.id === session &&
            !this.interaction.isAborted && this.props.isActivated &&
            this.maskAdjustments.get(index) === entry && this.interaction.latestResponse[index] === source;

        try {
            this.maskAdjustmentClient ??= new MaskMorphologyClient();
            const bounds: [number, number, number, number] = this.state.interactorRegionOfInterest ??
                [0, 0, this.props.frameData.width, this.props.frameData.height];
            const rle = await this.maskAdjustmentClient.apply(source.rle, value, bounds);
            if (!isCurrent()) return;
            if (rle === null) {
                entry.pending = false;
                this.refreshMaskAdjustments();
                return;
            }
            const contours = rle.length ? this.receiveContoursFromMask(rle) : [];
            const points = contours.length ? this.receivePointsFromMask(contours) : [];
            entry.preview = {
                ...source,
                rle,
                contours,
                points,
                empty: !rle.length,
                approximatedPoints: this.approximateResponsePoints(points),
            };
            entry.pending = false;
            this.refreshMaskAdjustments();
        } catch {
            if (!isCurrent()) return;
            this.maskAdjustments.delete(index);
            this.refreshMaskAdjustments();
            notification.error({
                message: 'Could not adjust mask',
                description: 'The latest SAM3 mask has been restored. Try the adjustment again.',
            });
        }
    };

    private selectRefinementMask = (index: number): void => {
        if (!this.props.isActivated || this.interaction.isAborted || !this.supportsMaskRefinement() ||
            this.refinement?.index === index) return;
        const entry = this.visibleInteractionResults().find((item) => item.index === index);
        if (!entry) return;
        this.invalidateRefinementRequests();
        this.refinement = { index, seed: entry.result };
        this.setState({ refiningMask: index }, () => {
            this.drawIntermediateShapesOnCanvas();
            this.props.canvasInstance.interact({
                enabled: true,
                command: 'draw_points',
                payload: { shapes: [], clearPrompts: true },
                settings: {
                    crosshair: false,
                    points_type: 'any',
                    appendCursorPositionAsPoint: false,
                    removalStrategy: 'any',
                    hint: `Refining mask ${index + 1}`,
                    ...(this.state.interactorRegionOfInterest ? {
                        regionOfInterest: this.state.interactorRegionOfInterest,
                    } : {}),
                },
            });
        });
    };

    private finishRefinement = (): void => {
        this.invalidateRefinementRequests();
        this.refinement = null;
        this.setState({ refiningMask: null }, () => this.drawIntermediateShapesOnCanvas());
    };

    private drawIntermediateShapesOnCanvas(): void {
        const { canvasInstance } = this.props;
        const { convertMasksToPolygons } = this.state;
        const shapesToBeDrawn = this.visibleInteractionResults()
            .map(({ result, index }) => ({ result: this.displayedMaskResult(index, result), index }))
            .filter(({ result }) => !result.empty &&
                (convertMasksToPolygons ? result.approximatedPoints.length >= 3 : result.rle.length >= 6))
            .map(({ result: { rle, contours, approximatedPoints }, index }) => ({
                id: index,
                selected: this.refinement?.index === index,
                selectionPoints: rle,
                shapeType: convertMasksToPolygons ? ShapeType.POLYGON : ShapeType.MASK,
                points: convertMasksToPolygons ? approximatedPoints.flat() : rle,
                maskOutlines: contours.map((contour) => contour.flat()),
            }));

        canvasInstance.interact({
            enabled: true,
            command: 'put_shapes',
            payload: {
                shapes: shapesToBeDrawn,
            },
        });

        if (this.supportsMaskRefinement() && !this.refinement) {
            canvasInstance.interact({
                enabled: true,
                command: 'select_shape',
                payload: { shapes: [], clearPrompts: true },
                settings: { crosshair: false },
            });
        }

        if (!shapesToBeDrawn.length) {
            if (!this.interaction.noShapesMessage) {
                this.interaction.noShapesMessage = message.info({
                    content: 'No shapes to display',
                    duration: 0,
                });
            }
        } else if (this.interaction.noShapesMessage) {
            this.interaction.noShapesMessage();
            this.interaction.noShapesMessage = null;
        }
    }

    private collectTrackerPortals(): React.ReactPortal[] {
        const { states, fetchAnnotations } = this.props;
        const { trackedShapes, activeTracker } = this.state;

        const trackedClientIDs = trackedShapes.map((trackedShape: TrackedShape) => trackedShape.clientID);
        const portals = !activeTracker ?
            [] :
            states
                .filter((objectState) => objectState.objectType === 'track' && objectState.shapeType === 'rectangle')
                .map((objectState: any): React.ReactPortal | null => {
                    const { clientID } = objectState;
                    const selectorID = `#cvat-objects-sidebar-state-item-${clientID}`;
                    let targetElement = window.document.querySelector(
                        `${selectorID} .cvat-object-item-button-prev-keyframe`,
                    ) as HTMLElement;

                    const isTracked = trackedClientIDs.includes(clientID);
                    if (targetElement) {
                        targetElement = targetElement.parentElement?.parentElement as HTMLElement;
                        return ReactDOM.createPortal(
                            <Col>
                                {isTracked ? (
                                    <CVATTooltip overlay='Disable tracking'>
                                        <EnvironmentFilled
                                            onClick={() => {
                                                const filteredStates = trackedShapes.filter(
                                                    (trackedShape: TrackedShape) => trackedShape.clientID !== clientID,
                                                );
                                                /* eslint no-param-reassign: ["error", { "props": false }] */
                                                objectState.descriptions = [];
                                                objectState.save().then(() => {
                                                    this.setState({
                                                        trackedShapes: filteredStates,
                                                    });
                                                    fetchAnnotations();
                                                });
                                            }}
                                        />
                                    </CVATTooltip>
                                ) : (
                                    <CVATTooltip overlay={`Enable tracking using ${activeTracker.name}`}>
                                        <EnvironmentOutlined
                                            onClick={() => {
                                                objectState.descriptions = [`Trackable (${activeTracker.name})`];
                                                objectState.keyframe = true;
                                                objectState.save().then(() => {
                                                    this.setState({
                                                        trackedShapes: [
                                                            ...trackedShapes,
                                                            {
                                                                clientID,
                                                                serverlessState: null,
                                                                shapePoints: objectState.points,
                                                                trackerModel: activeTracker,
                                                            },
                                                        ],
                                                    });
                                                    fetchAnnotations();
                                                });
                                            }}
                                        />
                                    </CVATTooltip>
                                )}
                            </Col>,
                            targetElement,
                        );
                    }

                    return null;
                })
                .filter((portal: ReactPortal | null) => portal !== null);

        return portals as React.ReactPortal[];
    }

    private async checkTrackedStates(prevProps: Props): Promise<void> {
        const {
            frame,
            jobInstance,
            states: objectStates,
            trackers,
            fetchAnnotations,
            switchNavigationBlocked,
        } = this.props;
        const { trackedShapes } = this.state;
        let withServerRequest = false;

        type AccumulatorType = {
            // These maps are indexed by tracker ID.
            stateful: Map<string | number, {
                clientIDs: number[];
                states: any[];
                shapes: MinimalShape[];
            }>;
            stateless: Map<string | number, {
                clientIDs: number[];
                shapes: MinimalShape[];
            }>;
        };

        if (prevProps.frame !== frame && trackedShapes.length) {
            // 1. find all trackable objects on the current frame
            // 2. divide them into two groups: with relevant state, without relevant state
            const trackingData = trackedShapes.reduce<AccumulatorType>(
                (acc: AccumulatorType, trackedShape: TrackedShape): AccumulatorType => {
                    const {
                        serverlessState, shapePoints, clientID, trackerModel,
                    } = trackedShape;
                    const clientState = objectStates.find((_state): boolean => _state.clientID === clientID);
                    const keyframes = clientState?.keyframes;

                    if (
                        !clientState || !keyframes ||
                        keyframes?.prev !== frame - 1 ||
                        (typeof keyframes?.last === 'number' && keyframes?.last >= frame)
                    ) {
                        return acc;
                    }

                    if (clientState && !clientState.outside) {
                        const points = clientState.points as number[];
                        withServerRequest = true;
                        const stateIsRelevant =
                            serverlessState !== null &&
                            points.length === shapePoints.length &&
                            points.every((coord: number, i: number) => coord === shapePoints[i]);
                        if (stateIsRelevant) {
                            const container = acc.stateful.get(trackerModel.id) ?? {
                                clientIDs: [],
                                shapes: [],
                                states: [],
                            };
                            container.clientIDs.push(clientID);
                            container.shapes.push({ type: clientState.shapeType, points });
                            container.states.push(serverlessState);
                            acc.stateful.set(trackerModel.id, container);
                        } else {
                            const container = acc.stateless.get(trackerModel.id) ?? {
                                clientIDs: [],
                                shapes: [],
                            };
                            container.clientIDs.push(clientID);
                            container.shapes.push({ type: clientState.shapeType, points });
                            acc.stateless.set(trackerModel.id, container);
                        }
                    }

                    return acc;
                },
                {
                    stateful: new Map(),
                    stateless: new Map(),
                },
            );

            try {
                if (withServerRequest) {
                    switchNavigationBlocked(true);
                }
                // 3. get relevant state for the second group
                for (const [trackerID, trackableObjects] of trackingData.stateless) {
                    let hideMessage = null;
                    try {
                        const [tracker] = trackers.filter((_tracker: MLModel) => _tracker.id === trackerID);
                        if (!tracker) {
                            throw new Error(`Suitable tracker with ID ${trackerID} not found in tracker list`);
                        }

                        const numOfObjects = trackableObjects.clientIDs.length;
                        hideMessage = message.loading({
                            content: `${tracker.name}: states are being initialized for ${numOfObjects} ${
                                numOfObjects > 1 ? 'objects' : 'object'
                            } ..`,
                            duration: 0,
                            className: 'cvat-tracking-notice',
                        });

                        const response = await core.lambda.call(jobInstance.taskId, tracker, {
                            type: 'init_tracking',
                            frame: frame - 1,
                            shapes: trackableObjects.shapes,
                            job: jobInstance.id,
                        }) as TrackerResults;

                        const { states: serverlessStates } = response;
                        const statefulContainer = trackingData.stateful.get(trackerID) ?? {
                            clientIDs: [],
                            shapes: [],
                            states: [],
                        };

                        Array.prototype.push.apply(statefulContainer.clientIDs, trackableObjects.clientIDs);
                        Array.prototype.push.apply(statefulContainer.shapes, trackableObjects.shapes);
                        Array.prototype.push.apply(statefulContainer.states, serverlessStates);
                        trackingData.stateful.set(trackerID, statefulContainer);
                        trackingData.stateless.delete(trackerID);
                    } catch (error: any) {
                        notification.error({
                            message: 'Tracker initialization error',
                            description: <CVATMarkdown>{error.message}</CVATMarkdown>,
                            duration: null,
                        });
                    } finally {
                        if (hideMessage) hideMessage();
                    }
                }

                for (const [trackerID, trackableObjects] of trackingData.stateful) {
                    // 4. run tracking for all the objects
                    let hideMessage = null;
                    try {
                        const [tracker] = trackers.filter((_tracker: MLModel) => _tracker.id === trackerID);
                        if (!tracker) {
                            throw new Error(`Suitable tracker with ID ${trackerID} not found in tracker list`);
                        }

                        const numOfObjects = trackableObjects.clientIDs.length;
                        hideMessage = message.loading({
                            content: `${tracker.name}: ${numOfObjects} ${
                                numOfObjects > 1 ? 'objects are' : 'object is'
                            } being tracked..`,
                            duration: 0,
                            className: 'cvat-tracking-notice',
                        });

                        const response = await core.lambda.call(jobInstance.taskId, tracker, {
                            type: 'track',
                            frame,
                            states: trackableObjects.states,
                            job: jobInstance.id,
                        }) as TrackerResults;

                        response.shapes = response.shapes.map(trackedRectangleMapper);
                        for (let i = 0; i < trackableObjects.clientIDs.length; i++) {
                            const clientID = trackableObjects.clientIDs[i];
                            const shape = response.shapes[i];
                            const state = response.states[i];
                            const [objectState] = objectStates.filter(
                                (_state: any): boolean => _state.clientID === clientID,
                            );
                            const [trackedShape] = trackedShapes.filter(
                                (_trackedShape: TrackedShape) => _trackedShape.clientID === clientID,
                            );
                            objectState.points = shape.points;
                            objectState.save().then(() => {
                                trackedShape.serverlessState = state;
                                trackedShape.shapePoints = shape.points;
                            });
                        }
                    } catch (error: any) {
                        notification.error({
                            message: 'Tracking error',
                            description: <CVATMarkdown>{error.message}</CVATMarkdown>,
                            duration: null,
                        });
                    } finally {
                        if (hideMessage) hideMessage();
                        fetchAnnotations();
                    }
                }
            } finally {
                if (withServerRequest) {
                    switchNavigationBlocked(false);
                }
            }
        }
    }

    private async constructFromLatestResponse(): Promise<void> {
        const { convertMasksToPolygons, thresholdValue } = this.state;
        const {
            frame, labels, currentZOrder, activeLabelID, createAnnotations,
        } = this.props;

        if (!this.interaction.latestResponse.length) {
            return;
        }

        const objectsToConstruct = this.interaction.latestResponse
            .map((result, index) => this.displayedMaskResult(index, result)).filter(
                ({ confidence }) => typeof confidence !== 'number' || confidence >= thresholdValue,
            );

        let skippedShapes = 0;
        let objects: ObjectState[] = [];
        if (convertMasksToPolygons) {
            objects = objectsToConstruct
                .filter(({ approximatedPoints }) => approximatedPoints.length >= 3)
                .map(({ approximatedPoints, labelName }) => {
                    // Resolve label: use per-shape labelName if provided (authoritative),
                    // otherwise fall back to activeLabelID (legacy path for SAM3 etc.)
                    let label: Label | undefined;
                    if (labelName !== null && labelName !== undefined) {
                        // labelName is authoritative - no fallback if it doesn't match
                        label = labels.find((l) => l.name === labelName);
                    } else {
                        // Legacy path: use activeLabelID when labelName is absent
                        label = labels.find((l) => l.id === activeLabelID as number);
                    }

                    if (!label) {
                        skippedShapes += 1;
                        return null;
                    }

                    const common = {
                        frame,
                        objectType: ObjectType.SHAPE,
                        source: core.enums.Source.SEMI_AUTO,
                        label,
                        occluded: false,
                        zOrder: currentZOrder,
                    };

                    return new core.classes.ObjectState({
                        shapeType: ShapeType.POLYGON,
                        points: approximatedPoints.flat(),
                        ...common,
                    });
                })
                .filter((obj) => obj !== null) as ObjectState[];
        } else {
            objects = objectsToConstruct
                .filter(({ rle }) => rle.length >= 6) // minimal RLE length for a valid shape
                .map(({ rle, labelName }) => {
                    // Resolve label: use per-shape labelName if provided (authoritative),
                    // otherwise fall back to activeLabelID (legacy path for SAM3 etc.)
                    let label: Label | undefined;
                    if (labelName !== null && labelName !== undefined) {
                        // labelName is authoritative - no fallback if it doesn't match
                        label = labels.find((l) => l.name === labelName);
                    } else {
                        // Legacy path: use activeLabelID when labelName is absent
                        label = labels.find((l) => l.id === activeLabelID as number);
                    }

                    if (!label) {
                        skippedShapes += 1;
                        return null;
                    }

                    const common = {
                        frame,
                        objectType: ObjectType.SHAPE,
                        source: core.enums.Source.SEMI_AUTO,
                        label,
                        occluded: false,
                        zOrder: currentZOrder,
                    };

                    return new core.classes.ObjectState({
                        shapeType: ShapeType.MASK,
                        points: Array.from(rle),
                        ...common,
                    });
                })
                .filter((obj) => obj !== null) as ObjectState[];
        }

        if (skippedShapes > 0) {
            notification.warning({
                message: 'Some shapes were skipped',
                description: (
                    `${skippedShapes} shape(s) could not be created because ` +
                    'their labels could not be resolved'
                ),
                duration: 5,
            });
        }

        createAnnotations(objects);
    }

    private async initializeOpenCV(): Promise<void> {
        if (!openCVWrapper.isInitialized) {
            const hide = message.loading('Initializing contour utilities..', 0);
            try {
                await openCVWrapper.initialize(() => {});
            } catch (error: any) {
                notification.error({
                    message: 'Could not initialize contour utilities',
                    description: <CVATMarkdown>{error.message}</CVATMarkdown>,
                    duration: null,
                });
            } finally {
                hide();
            }
        }
    }

    private receivePointsFromMask(contours: [number, number][][]): [number, number][] {
        if (contours.length) {
            return contours[0].map<[number, number]>((val) => [val[0], val[1]]);
        }

        return [];
    }

    private receiveContoursFromMask(mask: Int32Array): [number, number][][] {
        if (!openCVWrapper.isInitialized) {
            throw new Error('OpenCV was not initialized');
        }

        if (mask.length < 6) {
            // minimal non-empty RLE is 6 points
            return [];
        }

        return openCVWrapper.getContoursFromStateSync({ points: mask, shapeType: ShapeType.MASK });
    }

    private approximateResponsePoints(points: [number, number][]): [number, number][] {
        if (!openCVWrapper.isInitialized) {
            throw new Error('OpenCV was not initialized');
        }

        const { approxPolyAccuracy } = this.state;
        if (points.length > 3) {
            const threshold = openCVWrapper.utils.thresholdFromAccuracy(approxPolyAccuracy);
            return openCVWrapper.contours.approxPoly(points, threshold);
        }

        return points;
    }

    private renderLabelBlock(): JSX.Element {
        const { labels } = this.props;
        const { activeLabelID } = this.state;
        return (
            <>
                <Row justify='start'>
                    <Col>
                        <Text className='cvat-text-color'>Label</Text>
                    </Col>
                </Row>
                <Row justify='center'>
                    <Col span={24}>
                        <LabelSelector
                            style={{ width: '100%' }}
                            labels={labels}
                            value={activeLabelID}
                            onChange={(value: any) => this.setState({ activeLabelID: value.id })}
                        />
                    </Col>
                </Row>
            </>
        );
    }

    private renderTrackerBlock(): JSX.Element {
        const {
            canvasInstance, jobInstance, frame, onInteractionStart,
        } = this.props;
        const { activeTracker, activeLabelID, fetching } = this.state;

        const supportedTrackers = this.getSupportedTrackers();

        if (!supportedTrackers.length) {
            return (
                <Row justify='center' align='middle' style={{ marginTop: '5px' }}>
                    <Col>
                        <Text type='warning' className='cvat-text-color'>
                            No available trackers found
                        </Text>
                    </Col>
                </Row>
            );
        }

        return (
            <>
                <Row justify='start'>
                    <Col>
                        <Text className='cvat-text-color'>Tracker</Text>
                    </Col>
                </Row>
                <Row align='middle' justify='center'>
                    <Col span={24}>
                        <Select
                            style={{ width: '100%' }}
                            defaultValue={supportedTrackers[0].name}
                            onChange={this.setActiveTracker}
                        >
                            {supportedTrackers.map(
                                (tracker: MLModel): JSX.Element => (
                                    <Select.Option value={tracker.id} title={tracker.description} key={tracker.id}>
                                        {tracker.name}
                                    </Select.Option>
                                ),
                            )}
                        </Select>
                    </Col>
                </Row>
                <Row align='middle' justify='end'>
                    <Col>
                        <Button
                            type='primary'
                            loading={fetching}
                            className='cvat-tools-track-button'
                            data-primary-action='true'
                            disabled={!activeTracker || fetching || frame === jobInstance.stopFrame}
                            onClick={() => {
                                if (activeTracker && activeLabelID) {
                                    const { onSwitchToolsBlockerState } = this.props;
                                    this.setState({ mode: 'tracking' });
                                    const parameters = { command: 'draw_box' as const, settings: { crosshair: true } };
                                    canvasInstance.cancel();
                                    canvasInstance.interact({ enabled: true, ...parameters });
                                    onInteractionStart(activeTracker, activeLabelID, parameters);
                                    onSwitchToolsBlockerState({ buttonVisible: false });
                                }
                            }}
                        >
                            Track
                        </Button>
                    </Col>
                </Row>
            </>
        );
    }

    private renderInteractorBlock(): JSX.Element {
        const {
            interactors, canvasInstance, labels, onInteractionStart, interactorExtras,
        } = this.props;
        const {
            activeInteractor, activeLabelID, fetching, startInteractingWithBox, convertMasksToPolygons,
            interactorExtraParams, allowROI, interactorPromptMode, conceptUsesBox,
        } = this.state;

        if (!interactors.length) {
            return (
                <Row justify='center' align='middle' style={{ marginTop: '5px' }}>
                    <Col>
                        <Text type='warning' className='cvat-text-color'>
                            No available interactors found
                        </Text>
                    </Col>
                </Row>
            );
        }

        const minNegVertices = activeInteractor?.params?.canvas?.minNegVertices ?? -1;
        const renderStartWithBox = activeInteractor?.params?.canvas?.startWithBoxOptional ?? false;
        const hasMappableLabels = activeInteractor && activeInteractor.labels && activeInteractor.labels.length > 0;
        const schema = (activeInteractor?.extraParamsSchema ?? []) as ModelExtraParamSchemaItem[];
        const textPromptSchema = schema.find((param) => param.name === 'text_prompt' && param.type === 'text');
        const hasTextPrompting = this.hasTextPrompting();
        const supportsConceptPrompting = this.supportsConceptPrompting();
        const conceptMode = hasTextPrompting && interactorPromptMode === 'concept';
        const conceptUsesExemplar = conceptMode && supportsConceptPrompting && conceptUsesBox;
        const activeLabel = labels.find((label) => label.id === activeLabelID);
        const textPrompt = typeof interactorExtraParams.text_prompt === 'string' ?
            interactorExtraParams.text_prompt.trim() : '';
        const validConceptPrompt = textPrompt.length <= (textPromptSchema?.max_length ?? 256) &&
            (conceptUsesExemplar || textPrompt.length > 0);
        const commonSchema = schema.filter((param) => param !== textPromptSchema);
        const changeExtraParam = (name: string, value: unknown): void => {
            this.setState((state) => ({
                interactorExtraParams: { ...state.interactorExtraParams, [name]: value },
                interactorExtraParamsTouched: { ...state.interactorExtraParamsTouched, [name]: true },
            }));
        };

        const renderedInteractorExtras = interactorExtras
            .sort((a, b) => a.data.weight - b.data.weight)
            .filter((plugin) => plugin.data.shouldBeRendered(this.props, this.state))
            .map(({ component: Component }, index) => (
                <Component targetProps={this.props} targetState={this.state} key={index} />
            ));

        return (
            <>
                <Row justify='start'>
                    <Col>
                        <Text className='cvat-text-color'>Interactor</Text>
                    </Col>
                </Row>
                <Row align='middle' justify='space-between'>
                    <Col span={22}>
                        <Select
                            style={{ width: '100%' }}
                            value={activeInteractor?.id}
                            onChange={this.setActiveInteractor}
                            className='cvat-interactor-selector'
                        >
                            {interactors.map(
                                (interactor: MLModel): JSX.Element => (
                                    <Select.Option
                                        value={interactor.id}
                                        title={interactor.description}
                                        key={interactor.id}
                                    >
                                        {interactor.name}
                                    </Select.Option>
                                ),
                            )}
                        </Select>
                    </Col>
                    <Col span={2} className='cvat-interactors-tips-icon-container'>
                        <Popover
                            destroyTooltipOnHide
                            content={(
                                <ToolsTooltips
                                    name={activeInteractor?.name}
                                    withNegativePoints={minNegVertices >= 0}
                                    {...(activeInteractor?.tip || {})}
                                />
                            )}
                        >
                            <QuestionCircleOutlined />
                        </Popover>
                    </Col>
                </Row>

                {hasMappableLabels && activeInteractor && (
                    <InteractorLabelMapper
                        interactor={activeInteractor}
                        labels={labels}
                        onMappingChange={(mapping) => {
                            this.setState({ interactorMapping: mapping });
                        }}
                    />
                )}

                {!hasMappableLabels && this.renderLabelBlock()}

                {hasTextPrompting && (
                    <Row style={{ marginTop: 8 }}>
                        <Radio.Group
                            aria-label={supportsConceptPrompting ? 'SAM3 task mode' : 'Prompt mode'}
                            value={interactorPromptMode}
                            onChange={(event) => this.setState({ interactorPromptMode: event.target.value })}
                            options={supportsConceptPrompting ? [
                                { label: 'Single object', value: 'single_object' },
                                { label: 'Find similar objects', value: 'concept' },
                            ] : [
                                { label: 'Points / box', value: 'single_object' },
                                { label: 'Text', value: 'concept' },
                            ]}
                            optionType='button'
                        />
                    </Row>
                )}

                {commonSchema.length > 0 && (
                    <div className='cvat-tools-interactor-extra-params'>
                        <ModelExtraParamsForm
                            schema={commonSchema}
                            values={interactorExtraParams}
                            onChange={changeExtraParam}
                            title='Interactor parameters'
                        />
                    </div>
                )}

                {(textPromptSchema || renderStartWithBox) && (
                    <div className={`cvat-tools-interactor-mode-controls${supportsConceptPrompting ?
                        ' cvat-tools-interactor-mode-controls-concept-capable' : ''}`}
                    >
                        {conceptMode && textPromptSchema ? (
                            <div className='cvat-tools-interactor-concept-controls'>
                                <ModelExtraParamsForm
                                    schema={[supportsConceptPrompting ? {
                                        ...textPromptSchema,
                                        label: 'Concept description',
                                    } : textPromptSchema]}
                                    values={interactorExtraParams}
                                    onChange={changeExtraParam}
                                    title={supportsConceptPrompting ? 'Concept description' : 'Prompt'}
                                />
                                {supportsConceptPrompting && (
                                    <div className='cvat-tools-interactor-concept-actions'>
                                        <Button
                                            size='small'
                                            className='cvat-tools-use-label-name-button'
                                            disabled={!activeLabel}
                                            onClick={() => {
                                                if (activeLabel) {
                                                    changeExtraParam('text_prompt', activeLabel.name);
                                                }
                                            }}
                                        >
                                            Use label name
                                        </Button>
                                        <span className='cvat-tools-interactor-exemplar-control'>
                                            <Switch
                                                aria-label='Add positive exemplar box'
                                                checked={conceptUsesBox}
                                                onChange={(value: boolean) => this.setState({ conceptUsesBox: value })}
                                            />
                                            <Text>Add positive exemplar box</Text>
                                        </span>
                                    </div>
                                )}
                            </div>
                        ) : renderStartWithBox && (
                            <div className='cvat-tools-interactor-single-object-controls'>
                                <Switch
                                    aria-label='Start with a bounding box'
                                    checked={startInteractingWithBox}
                                    onChange={(value: boolean) => {
                                        localStorage.setItem(startWithBoxStorageItem, value.toString());
                                        this.setState({ startInteractingWithBox: value });
                                    }}
                                />
                                <Text>Start with a bounding box</Text>
                            </div>
                        )}
                    </div>
                )}

                <div className='cvat-tools-interactor-setups'>
                    {allowROI && this.renderROIControls()}
                    <div>
                        <Switch
                            checked={convertMasksToPolygons}
                            onChange={(checked: boolean) => {
                                this.setState({ convertMasksToPolygons: checked });
                            }}
                        />
                        <Text>Convert masks to polygons</Text>
                    </div>
                </div>
                <div className='cvat-tools-interactor-extras'>
                    {renderedInteractorExtras}
                </div>
                <Row align='middle' justify='end'>
                    <Col>
                        <Button
                            type='primary'
                            loading={fetching}
                            className='cvat-tools-interact-button'
                            data-primary-action='true'
                            disabled={!activeInteractor ||
                                fetching ||
                                activeInteractor.version < MIN_SUPPORTED_INTERACTOR_VERSION ||
                                (!hasMappableLabels && !activeLabelID) ||
                                (conceptMode && !validConceptPrompt)}
                            onClick={() => {
                                if (activeInteractor && labels.length && (hasMappableLabels || activeLabelID) &&
                                    !fetching && (!conceptMode || validConceptPrompt)) {
                                    this.lastInteractorSetup = {
                                        activeInteractor,
                                        activeLabelID,
                                        interactorPromptMode,
                                        conceptUsesBox,
                                        interactorExtraParams: lodash.cloneDeep(interactorExtraParams),
                                        interactorExtraParamsTouched: { ...this.state.interactorExtraParamsTouched },
                                        interactorMapping: lodash.cloneDeep(this.state.interactorMapping),
                                        interactorRegionOfInterest: lodash.cloneDeep(
                                            this.state.interactorRegionOfInterest,
                                        ),
                                    };
                                    const startWithBox = activeInteractor.params.canvas.startWithBoxOptional ? (
                                        startInteractingWithBox
                                    ) : activeInteractor.params.canvas.startWithBox ?? false;

                                    let parameters: Omit<Parameters<typeof canvasInstance.interact>[0], 'enabled'>;
                                    if (conceptMode) {
                                        parameters = conceptUsesExemplar ? {
                                            command: 'draw_box' as const,
                                            settings: {
                                                crosshair: true,
                                                ...(this.state.interactorRegionOfInterest ? {
                                                    regionOfInterest: this.state.interactorRegionOfInterest,
                                                } : {}),
                                            },
                                        } : {
                                            command: 'put_shapes' as const,
                                            payload: { shapes: [] },
                                            settings: { crosshair: false },
                                        };
                                    } else {
                                        parameters = {
                                            command: startWithBox ? 'draw_box' as const : 'draw_points' as const,
                                            settings: {
                                                appendCursorPositionAsPoint: false,
                                                removalStrategy: 'any' as const,
                                                points_type: 'any' as const,
                                                crosshair: startWithBox,
                                                ...(this.state.interactorRegionOfInterest ? {
                                                    regionOfInterest: this.state.interactorRegionOfInterest,
                                                } : {}),
                                            },
                                        };
                                    }
                                    if (conceptMode) {
                                        this.clearMaskAdjustments();
                                        this.refinement = null;
                                        this.refinementRevision++;
                                        this.interaction = {
                                            id: null,
                                            isAborted: false,
                                            latestPostponedRequest: null,
                                            latestResponse: [],
                                            latestRequest: null,
                                            closeFetchingMessage: null,
                                            noShapesMessage: null,
                                        };
                                    }
                                    const activateInteractor = (): void => {
                                        canvasInstance.cancel();
                                        canvasInstance.interact({ enabled: true, ...parameters });
                                        // For mapped multiclass interactors, pass -1 as a sentinel since the
                                        // label is determined by the mapping
                                        const labelID = activeLabelID ?? -1;
                                        onInteractionStart(activeInteractor, labelID, parameters);
                                    };
                                    if (conceptMode) {
                                        this.setState({
                                            mode: 'interaction',
                                            interactorResponseReceived: false,
                                            showConfidenceControl: false,
                                            refiningMask: null,
                                        }, activateInteractor);
                                    } else {
                                        this.setState({ mode: 'interaction' }, activateInteractor);
                                    }
                                }
                            }}
                        >
                            {conceptMode ? 'Find masks' : 'Interact'}
                        </Button>
                    </Col>
                </Row>
            </>
        );
    }

    private renderDetectorBlock(): JSX.Element {
        const {
            jobInstance, detectors, currentZOrder, frame, labels, frameData,
            createAnnotations,
        } = this.props;

        if (!detectors.length) {
            return (
                <Row justify='center' align='middle' style={{ marginTop: '5px' }}>
                    <Col>
                        <Text type='warning' className='cvat-text-color'>
                            No available detectors found
                        </Text>
                    </Col>
                </Row>
            );
        }

        return (
            <DetectorRunner
                withCleanup={false}
                enableInteractiveOptions
                loading={this.state.fetching}
                models={detectors}
                labels={labels}
                dimension={jobInstance.dimension}
                frameWidth={frameData.width}
                frameHeight={frameData.height}
                canvasInstance={this.props.canvasInstance}
                onRegionOfInterestChange={(detectorRegionOfInterest) => (
                    this.setState({ detectorRegionOfInterest })
                )}
                runInference={async (model: MLModel, body: AnnotateTaskRequestBody) => {
                    function loadAttributes(
                        attributes: { spec_id: number; value: string }[],
                    ): Record<number, string> {
                        return Object.fromEntries(attributes.map((a) => [a.spec_id, a.value]));
                    }

                    try {
                        this.setState({ mode: 'detection', fetching: true });

                        // The function call endpoint doesn't support the cleanup parameter.
                        const restOfBody = lodash.omit(body, 'cleanup');

                        const result = await core.lambda.call(jobInstance.taskId, model, {
                            ...restOfBody, type: 'annotate_frame', frame, job: jobInstance.id,
                        }) as DetectorResults;

                        const tagStates = result.tags.map((tag) => {
                            const jobLabel = jobInstance.labels
                                .find((jLabel) => jLabel.id === tag.label_id)!;

                            return new core.classes.ObjectState({
                                attributes: loadAttributes(tag.attributes),
                                frame,
                                label: jobLabel,
                                objectType: ObjectType.TAG,
                                source: core.enums.Source.AUTO,
                            });
                        });

                        const shapeStates = result.shapes.map((shape) => {
                            const jobLabel = jobInstance.labels
                                .find((jLabel) => jLabel.id === shape.label_id)!;

                            return new core.classes.ObjectState({
                                attributes: loadAttributes(shape.attributes),
                                elements: shape.elements?.map((element) => {
                                    const jobSublabel = jobLabel.structure!.sublabels
                                        .find((sublabel) => sublabel.id === element.label_id)!;

                                    return {
                                        attributes: loadAttributes(element.attributes),
                                        frame,
                                        label: jobSublabel,
                                        objectType: ObjectType.SHAPE,
                                        occluded: element.occluded,
                                        outside: element.outside,
                                        points: element.points,
                                        shapeType: element.type,
                                        source: core.enums.Source.AUTO,
                                    };
                                }),
                                frame,
                                label: jobLabel,
                                objectType: ObjectType.SHAPE,
                                occluded: shape.occluded,
                                points: shape.points,
                                rotation: shape.rotation,
                                shapeType: shape.type,
                                source: core.enums.Source.AUTO,
                                zOrder: currentZOrder,
                            });
                        });

                        createAnnotations([...tagStates, ...shapeStates]);
                    } catch (error: any) {
                        notification.error({
                            description: <CVATMarkdown>{error.message}</CVATMarkdown>,
                            message: 'Detection error occurred',
                            duration: null,
                        });
                    } finally {
                        this.setState({ fetching: false });
                    }
                }}
            />
        );
    }

    private renderPopoverContent(): JSX.Element {
        return (
            <div
                className='cvat-tools-control-popover-content'
                role='presentation'
                onKeyDown={primaryActionOnEnter}
            >
                <Row justify='start'>
                    <Col>
                        <Text className='cvat-text-color' strong>
                            AI Tools
                        </Text>
                    </Col>
                </Row>
                <Tabs
                    type='card'
                    tabBarGutter={8}
                    activeKey={this.state.activeTab}
                    onChange={(key) => this.setState({ activeTab: key as 'interactors' | 'detectors' | 'trackers' })}
                    items={[{
                        key: 'interactors',
                        label: 'Interactors',
                        children: this.renderInteractorBlock(),
                    }, {
                        key: 'detectors',
                        label: 'Detectors',
                        children: this.renderDetectorBlock(),
                    }, {
                        key: 'trackers',
                        label: 'Trackers',
                        children: (
                            <>
                                {this.renderLabelBlock()}
                                {this.renderTrackerBlock()}
                            </>
                        ),
                    }]}
                />
            </div>
        );
    }

    public render(): JSX.Element | null {
        const {
            interactors, detectors, trackers, isActivated,
            canvasInstance, labels, frameData,
        } = this.props;
        const {
            fetching, approxPolyAccuracy, interactorResponseReceived, thresholdValue,
            showConfidenceControl, mode, portals, convertMasksToPolygons,
        } = this.state;

        if (![...interactors, ...detectors, ...trackers].length) return null;

        const dynamicPopoverProps = isActivated ?
            {
                overlayStyle: {
                    display: 'none',
                },
            } :
            {};

        const dynamicIconProps = isActivated ?
            {
                className: 'cvat-tools-control cvat-active-canvas-control',
                onClick: (): void => {
                    canvasInstance.interact({ enabled: false });
                },
            } :
            {
                className: 'cvat-tools-control',
            };

        const showAnyContent = labels.length && !frameData.deleted;
        const showInteractionContent = isActivated && mode === 'interaction' && interactorResponseReceived;
        const showDetectionContent = fetching && mode === 'detection';

        const interactionContent: JSX.Element | null = showInteractionContent ? (
            <>
                {this.supportsMaskRefinement() && (
                    <TextMaskRefinement
                        masks={this.visibleInteractionResults().map(({ index }) => index)}
                        selected={this.state.refiningMask}
                        fetching={fetching}
                        adjusting={Array.from(this.maskAdjustments.values()).some(({ pending }) => pending)}
                        onSelect={this.selectRefinementMask}
                        onBack={this.finishRefinement}
                        onDone={() => canvasInstance.interact({ enabled: false })}
                    />
                )}
                { convertMasksToPolygons && (
                    <ApproximationAccuracy
                        approxPolyAccuracy={approxPolyAccuracy}
                        onChange={(value: number) => {
                            this.setState({ approxPolyAccuracy: value });
                        }}
                    />
                )}
                { showConfidenceControl && (
                    <ConfidenceThreshold
                        thresholdValue={thresholdValue}
                        onChange={(value: number) => {
                            this.setState({ thresholdValue: value });
                        }}
                    >
                        {this.supportsMaskRefinement() && (
                            <MaskMorphologyControl
                                value={this.maskAdjustments.get(this.state.refiningMask as number)?.value ?? 0}
                                disabled={this.state.refiningMask === null}
                                pending={this.maskAdjustments.get(this.state.refiningMask as number)?.pending ?? false}
                                onChange={(value: number) => {
                                    if (this.state.refiningMask !== null) {
                                        this.applyMaskAdjustment(this.state.refiningMask, value);
                                    }
                                }}
                            />
                        )}
                    </ConfidenceThreshold>
                )}
            </>
        ) : null;

        const detectionContent: JSX.Element | null = showDetectionContent ? (
            <Modal
                title='Making a server request'
                zIndex={Number.MAX_SAFE_INTEGER}
                open
                destroyOnClose
                closable={false}
                footer={[]}
            >
                <Text>Waiting for a server response..</Text>
                <LoadingOutlined style={{ marginLeft: '10px' }} />
            </Modal>
        ) : null;

        return showAnyContent ? (
            <>
                {this.renderRegionOfInterestOverlay()}
                <CustomPopover
                    {...dynamicPopoverProps}
                    placement='right'
                    content={this.renderPopoverContent()}
                    onVisibleChange={(visible: boolean) => this.setState({ toolsPopoverVisible: visible })}
                >
                    <Icon {...dynamicIconProps} component={AIToolsIcon} />
                </CustomPopover>
                {interactionContent}
                {detectionContent}
                {portals}
            </>
        ) : (
            <Icon className=' cvat-tools-control cvat-disabled-canvas-control' component={AIToolsIcon} />
        );
    }
}

export default connect(mapStateToProps, mapDispatchToProps)(ToolsControlComponent);
