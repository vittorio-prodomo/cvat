// Copyright (C) 2020-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import './styles.scss';
import React, { useEffect, useRef, useState } from 'react';
import { Row, Col } from 'antd/lib/grid';
import Select from 'antd/lib/select';
import Text from 'antd/lib/typography/Text';
import InputNumber from 'antd/lib/input-number';
import Button from 'antd/lib/button';
import Switch from 'antd/lib/switch';
import Checkbox from 'antd/lib/checkbox';
import notification from 'antd/lib/notification';
import { QuestionCircleOutlined } from '@ant-design/icons';

import CVATTooltip from 'components/common/cvat-tooltip';
import ModelExtraParamsForm, {
    buildExtraParamsDefaults,
    ModelExtraParamSchemaItem,
} from 'components/common/model-extra-params-form';
import { clamp } from 'utils/math';
import primaryActionOnEnter from 'utils/primary-action-enter';
import {
    MLModel, ModelKind, DimensionType, Label, LabelType,
} from 'cvat-core-wrapper';
import { type Canvas } from 'cvat-canvas-wrapper';

import LabelsMapperComponent, { LabelInterface, FullMapping } from './labels-mapper';
import {
    ServerMapping,
    convertMappingToServer,
    convertTaskLabels,
    convertModelLabels,
} from './label-mapping-utils';
import RegionOfInterestInputComponent from './region-of-interest-input';
import {
    DEFAULT_DETECTOR_RUN_OPTIONS,
    buildDetectorRequestThreshold,
    isDetectorThresholdInputValid,
    isPostprocessingThresholdInputValid,
    parseDetectorThresholdInput,
    type DetectorOverlapMetric,
    type DetectorPostprocessingMethod,
    type DetectorRunOptions,
} from './detector-runner-config';

export type RegionOfInterest = NonNullable<AnnotateTaskRequestBody['roi']> | null;

interface BaseProps {
    withCleanup: boolean;
    loading?: boolean;
    models: MLModel[];
    labels: Label[];
    dimension: DimensionType;
    frameWidth?: number;
    frameHeight?: number;
    canvasInstance?: Canvas;
    onRegionOfInterestChange?: (regionOfInterest: RegionOfInterest) => void;
    onModelChange?(modelID: string | null): void;
}

interface InteractiveProps extends BaseProps {
    enableInteractiveOptions: true;
    runInference(model: MLModel, body: object, options: DetectorRunOptions): void;
}

interface TaskProps extends BaseProps {
    enableInteractiveOptions?: false;
    runInference(model: MLModel, body: object): void;
}

type Props = InteractiveProps | TaskProps;

export interface AnnotateTaskRequestBody {
    type: 'annotate_task';
    mapping: ServerMapping;
    cleanup: boolean;
    conv_mask_to_poly: boolean;
    threshold?: number;
    extra_params?: Record<string, unknown>;
    roi?: [number, number, number, number];
}

function resynchronizeInput(
    input: React.RefObject<HTMLInputElement>,
    updateInput: (value: string) => void,
): void {
    window.setTimeout(() => {
        if (input.current) {
            updateInput(input.current.value);
        }
    }, 0);
}

function DetectorRunner(props: Props): JSX.Element {
    const {
        models, withCleanup, labels, dimension, loading = false,
        frameWidth, frameHeight, canvasInstance, onRegionOfInterestChange,
        enableInteractiveOptions = false, onModelChange,
    } = props;

    const [modelID, setModelID] = useState<string | null>(null);
    const [threshold, setThreshold] = useState<number>(0.5);
    const [distance, setDistance] = useState<number>(50);
    const [cleanup, setCleanup] = useState<boolean>(false);
    const [mapping, setMapping] = useState<FullMapping>([]);
    const [convertMasksToPolygons, setConvertMasksToPolygons] = useState<boolean>(false);
    const [detectorThreshold, setDetectorThreshold] = useState<number | null>(null);
    const [detectorThresholdInput, setDetectorThresholdInput] = useState<string>('');
    const [modelLabels, setModelLabels] = useState<LabelInterface[]>([]);
    const [taskLabels, setTaskLabels] = useState<LabelInterface[]>([]);
    const [extraParams, setExtraParams] = useState<Record<string, unknown>>({});
    const [regionOfInterest, setRegionOfInterest] = useState<RegionOfInterest>(null);
    const [previewConfidence, setPreviewConfidence] = useState<boolean>(
        DEFAULT_DETECTOR_RUN_OPTIONS.previewConfidence,
    );
    const [postprocessingMethod, setPostprocessingMethod] = useState<DetectorPostprocessingMethod>(
        DEFAULT_DETECTOR_RUN_OPTIONS.postprocessing.method,
    );
    const [postprocessingMetric, setPostprocessingMetric] = useState<DetectorOverlapMetric>(
        DEFAULT_DETECTOR_RUN_OPTIONS.postprocessing.metric,
    );
    const [postprocessingThreshold, setPostprocessingThreshold] = useState<number | null>(
        DEFAULT_DETECTOR_RUN_OPTIONS.postprocessing.threshold,
    );
    const [postprocessingThresholdInput, setPostprocessingThresholdInput] = useState<string>(
        String(DEFAULT_DETECTOR_RUN_OPTIONS.postprocessing.threshold),
    );
    const detectorThresholdInputRef = useRef<HTMLInputElement>(null);
    const postprocessingThresholdInputRef = useRef<HTMLInputElement>(null);

    const model = models.find((_model): boolean => _model.id === modelID);
    const isDetector = model?.kind === ModelKind.DETECTOR;
    const isReId = model?.kind === ModelKind.REID;
    const showROI = isDetector && dimension === DimensionType.DIMENSION_2D;
    const convertMasks2PolygonVisible = isDetector &&
        [LabelType.ANY, LabelType.MASK].includes(model.returnType);

    const effectivePreview = enableInteractiveOptions && previewConfidence;
    const detectorThresholdValid = effectivePreview || isDetectorThresholdInputValid(detectorThresholdInput);
    const postprocessingValid = isPostprocessingThresholdInputValid(
        postprocessingMethod,
        postprocessingThresholdInput,
    );
    const buttonEnabled = model && (isReId || (
        isDetector && mapping.length && detectorThresholdValid && postprocessingValid
    ));

    // Reset extra params to schema defaults whenever the selected model changes
    useEffect(() => {
        const schema = (model?.extraParamsSchema ?? []) as ModelExtraParamSchemaItem[];
        if (schema.length > 0) {
            setExtraParams(buildExtraParamsDefaults(schema));
        } else {
            setExtraParams({});
        }
    }, [modelID]);

    useEffect(() => {
        setTaskLabels(convertTaskLabels(labels));
        if (model) {
            setModelLabels(convertModelLabels(model));
            if (!model.labels.length && model.kind !== ModelKind.REID) {
                notification.warning({ message: 'This model does not have specified labels' });
            }
        } else {
            setModelLabels([]);
        }
    }, [labels, model]);

    useEffect(() => {
        if (!showROI) {
            setRegionOfInterest(null);
        }
    }, [showROI]);

    useEffect(() => {
        if (onRegionOfInterestChange) {
            onRegionOfInterestChange(regionOfInterest);
        }
    }, [regionOfInterest]);

    return (
        <div className='cvat-run-model-content' role='presentation' onKeyDown={primaryActionOnEnter}>
            <Row align='middle'>
                <Col span={4}>Model:</Col>
                <Col span={20}>
                    <Select
                        placeholder={dimension === DimensionType.DIMENSION_2D ? 'Select a model' : 'No models available'}
                        disabled={dimension !== DimensionType.DIMENSION_2D}
                        style={{ width: '100%' }}
                        onChange={(_modelID: string): void => {
                            setModelID(_modelID);
                            onModelChange?.(_modelID);
                        }}
                    >
                        {models.map(
                            (_model: MLModel): JSX.Element => (
                                <Select.Option value={_model.id} key={_model.id}>
                                    {_model.name}
                                </Select.Option>
                            ),
                        )}
                    </Select>
                </Col>
            </Row>
            {isDetector && (
                <div>
                    <div className='cvat-detector-runner-mapping-header'>
                        <Text>Setup mapping between labels and attributes</Text>
                        <CVATTooltip title='Each class, or attribute that model may predict, may be mapped to a label or attribute of the current specification'>
                            <QuestionCircleOutlined className='cvat-info-circle-icon' />
                        </CVATTooltip>
                    </div>
                    <LabelsMapperComponent
                        key={modelID} // rerender when model switched
                        onUpdateMapping={(_mapping: FullMapping) => setMapping(_mapping)}
                        modelLabels={modelLabels}
                        taskLabels={taskLabels}
                    />
                </div>
            )}
            {isDetector && (
                <div className='cvat-detector-runner-threshold-wrapper'>
                    <div>
                        <Text id='cvat-detector-confidence-threshold-label'>Threshold</Text>
                        <CVATTooltip title='Minimum confidence threshold for detections. Leave empty to use the default value specified in the model settings'>
                            <QuestionCircleOutlined className='cvat-info-circle-icon' />
                        </CVATTooltip>
                    </div>
                    <Row align='middle' justify='start'>
                        <Col>
                            <InputNumber<number | string>
                                ref={detectorThresholdInputRef}
                                id='cvat-detector-confidence-threshold-input'
                                aria-labelledby='cvat-detector-confidence-threshold-label'
                                aria-invalid={!detectorThresholdValid}
                                className='cvat-detector-confidence-threshold'
                                min={0.01}
                                step={0.01}
                                max={1}
                                value={detectorThreshold}
                                disabled={enableInteractiveOptions && previewConfidence}
                                status={!detectorThresholdValid ? 'error' : undefined}
                                parser={parseDetectorThresholdInput}
                                onChange={(value: number | string | null) => {
                                    setDetectorThreshold(value === null ? null : Number(value));
                                    setDetectorThresholdInput(value === null ? '' : String(value));
                                }}
                                onInput={setDetectorThresholdInput}
                                onBlur={() => resynchronizeInput(
                                    detectorThresholdInputRef,
                                    setDetectorThresholdInput,
                                )}
                                onPressEnter={(event) => {
                                    if (!detectorThresholdValid) {
                                        event.preventDefault();
                                        event.stopPropagation();
                                    }
                                    resynchronizeInput(
                                        detectorThresholdInputRef,
                                        setDetectorThresholdInput,
                                    );
                                }}
                            />
                        </Col>
                        {enableInteractiveOptions && (
                            <Col>
                                <Checkbox
                                    className='cvat-detector-preview-confidence-checkbox'
                                    checked={previewConfidence}
                                    onChange={(event) => setPreviewConfidence(event.target.checked)}
                                >
                                    Preview results before adding
                                </Checkbox>
                            </Col>
                        )}
                    </Row>
                </div>
            )}
            {isDetector && enableInteractiveOptions && (
                <div className='cvat-detector-postprocessing-wrapper'>
                    <Text>Postprocessing</Text>
                    <Row className='cvat-detector-postprocessing-row' gutter={8}>
                        <Col span={8}>
                            <Text type='secondary' id='cvat-detector-postprocessing-method-label'>Method</Text>
                            <Select
                                id='cvat-detector-postprocessing-method-select'
                                aria-labelledby='cvat-detector-postprocessing-method-label'
                                className='cvat-detector-postprocessing-method'
                                value={postprocessingMethod}
                                onChange={(value: DetectorPostprocessingMethod) => setPostprocessingMethod(value)}
                                options={[
                                    { value: 'disabled', label: 'Disabled' },
                                    { value: 'nms', label: 'NMS' },
                                    { value: 'nmm', label: 'NMM' },
                                    { value: 'greedy_nmm', label: 'NMM (greedy)' },
                                ]}
                            />
                        </Col>
                        <Col span={8}>
                            <Text type='secondary' id='cvat-detector-postprocessing-metric-label'>Metric</Text>
                            <Select
                                id='cvat-detector-postprocessing-metric-select'
                                aria-labelledby='cvat-detector-postprocessing-metric-label'
                                className='cvat-detector-postprocessing-metric'
                                value={postprocessingMetric}
                                disabled={postprocessingMethod === 'disabled'}
                                onChange={(value: DetectorOverlapMetric) => setPostprocessingMetric(value)}
                                options={[
                                    { value: 'ios', label: 'IoS' },
                                    { value: 'iou', label: 'IoU' },
                                ]}
                            />
                        </Col>
                        <Col span={8}>
                            <Text type='secondary' id='cvat-detector-postprocessing-threshold-label'>Overlap</Text>
                            <InputNumber<number | string>
                                ref={postprocessingThresholdInputRef}
                                id='cvat-detector-postprocessing-threshold-input'
                                aria-labelledby='cvat-detector-postprocessing-threshold-label'
                                aria-describedby={!postprocessingValid ?
                                    'cvat-detector-postprocessing-threshold-error' : undefined}
                                aria-invalid={!postprocessingValid}
                                className='cvat-detector-postprocessing-threshold'
                                min={0}
                                max={1}
                                step={0.01}
                                value={postprocessingThreshold}
                                disabled={postprocessingMethod === 'disabled'}
                                status={!postprocessingValid ? 'error' : undefined}
                                parser={parseDetectorThresholdInput}
                                onChange={(value: number | string | null) => {
                                    setPostprocessingThreshold(value === null ? null : Number(value));
                                    setPostprocessingThresholdInput(value === null ? '' : String(value));
                                }}
                                onInput={setPostprocessingThresholdInput}
                                onBlur={() => resynchronizeInput(
                                    postprocessingThresholdInputRef,
                                    setPostprocessingThresholdInput,
                                )}
                                onPressEnter={(event) => {
                                    if (!postprocessingValid) {
                                        event.preventDefault();
                                        event.stopPropagation();
                                    }
                                    resynchronizeInput(
                                        postprocessingThresholdInputRef,
                                        setPostprocessingThresholdInput,
                                    );
                                }}
                            />
                        </Col>
                    </Row>
                    {!postprocessingValid && (
                        <Text
                            id='cvat-detector-postprocessing-threshold-error'
                            type='danger'
                            className='cvat-detector-postprocessing-error'
                        >
                            Overlap must be between 0 and 1
                        </Text>
                    )}
                </div>
            )}
            {showROI && (
                <RegionOfInterestInputComponent
                    frameWidth={frameWidth}
                    frameHeight={frameHeight}
                    canvasInstance={canvasInstance}
                    onSubmit={setRegionOfInterest}
                />
            )}
            {convertMasks2PolygonVisible && (
                <div className='cvat-detector-runner-convert-masks-to-polygons-wrapper'>
                    <Switch
                        checked={convertMasksToPolygons}
                        onChange={(checked: boolean) => {
                            setConvertMasksToPolygons(checked);
                        }}
                    />
                    <Text>Convert masks to polygons</Text>
                </div>
            )}
            {isDetector && withCleanup && (
                <div className='cvat-detector-runner-clean-previous-annotations-wrapper'>
                    <Switch
                        checked={cleanup}
                        onChange={(checked: boolean): void => setCleanup(checked)}
                    />
                    <Text>Clean previous annotations</Text>
                </div>
            )}
            {isDetector && (
                <ModelExtraParamsForm
                    schema={(model?.extraParamsSchema ?? []) as ModelExtraParamSchemaItem[]}
                    values={extraParams}
                    onChange={(name, value) => {
                        setExtraParams((prev) => ({ ...prev, [name]: value }));
                    }}
                />
            )}
            {isReId ? (
                <div>
                    <Row align='middle' justify='start'>
                        <Col>
                            <Text>Threshold</Text>
                        </Col>
                        <Col offset={1}>
                            <CVATTooltip title='Minimum similarity value for shapes that can be merged'>
                                <InputNumber
                                    min={0.01}
                                    step={0.01}
                                    max={1}
                                    value={threshold}
                                    onChange={(value: number | undefined | string | null) => {
                                        if (typeof value !== 'undefined' && value !== null) {
                                            setThreshold(clamp(+value, 0.01, 1));
                                        }
                                    }}
                                />
                            </CVATTooltip>
                        </Col>
                    </Row>
                    <Row align='middle' justify='start'>
                        <Col>
                            <Text>Maximum distance</Text>
                        </Col>
                        <Col offset={1}>
                            <CVATTooltip title='Maximum distance between shapes that can be merged'>
                                <InputNumber
                                    placeholder='Threshold'
                                    min={1}
                                    value={distance}
                                    onChange={(value: number | undefined | string | null) => {
                                        if (typeof value !== 'undefined' && value !== null) {
                                            setDistance(+value);
                                        }
                                    }}
                                />
                            </CVATTooltip>
                        </Col>
                    </Row>
                </div>
            ) : null}
            <Row align='middle' justify='end'>
                <Col>
                    <Button
                        className='cvat-inference-run-button'
                        data-primary-action='true'
                        disabled={!buttonEnabled || loading}
                        loading={loading}
                        type='primary'
                        onClick={() => {
                            if (!model || loading) return;
                            const serverMapping = convertMappingToServer(mapping);
                            const interactiveOptions: DetectorRunOptions = {
                                previewConfidence: effectivePreview,
                                postprocessing: {
                                    method: postprocessingMethod,
                                    metric: postprocessingMetric,
                                    threshold: postprocessingThreshold ??
                                        DEFAULT_DETECTOR_RUN_OPTIONS.postprocessing.threshold,
                                },
                            };
                            if (model.kind === ModelKind.DETECTOR) {
                                const nonNullExtraParams = Object.fromEntries(
                                    Object.entries(extraParams).filter(([, v]) => v !== null && v !== undefined),
                                );
                                const requestThreshold = buildDetectorRequestThreshold(
                                    effectivePreview,
                                    detectorThreshold,
                                );
                                const body: AnnotateTaskRequestBody = {
                                    type: 'annotate_task',
                                    mapping: serverMapping,
                                    cleanup,
                                    conv_mask_to_poly: convertMasksToPolygons,
                                    ...(requestThreshold !== null ? { threshold: requestThreshold } : {}),
                                    ...(Object.keys(nonNullExtraParams).length ?
                                        { extra_params: nonNullExtraParams } :
                                        {}),
                                    ...(regionOfInterest ? { roi: regionOfInterest } : {}),
                                };

                                if (props.enableInteractiveOptions === true) {
                                    props.runInference(model, body, interactiveOptions);
                                } else {
                                    props.runInference(model, body);
                                }
                            } else if (model.kind === ModelKind.REID) {
                                const body = { threshold, max_distance: distance };
                                if (props.enableInteractiveOptions === true) {
                                    props.runInference(model, body, interactiveOptions);
                                } else {
                                    props.runInference(model, body);
                                }
                            }
                        }}
                    >
                        Annotate
                    </Button>
                </Col>
            </Row>
        </div>
    );
}

interface DetectorRunnerComponent {
    (props: TaskProps): JSX.Element;
    (props: InteractiveProps): JSX.Element;
}

export default React.memo(DetectorRunner) as DetectorRunnerComponent;
