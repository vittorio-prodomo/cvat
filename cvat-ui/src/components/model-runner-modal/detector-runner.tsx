// Copyright (C) 2020-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import './styles.scss';
import React, { useEffect, useState } from 'react';
import { Row, Col } from 'antd/lib/grid';
import Select from 'antd/lib/select';
import Text from 'antd/lib/typography/Text';
import InputNumber from 'antd/lib/input-number';
import Button from 'antd/lib/button';
import Switch from 'antd/lib/switch';
import Tag from 'antd/lib/tag';
import Divider from 'antd/lib/divider';
import notification from 'antd/lib/notification';
import { ArrowRightOutlined, QuestionCircleOutlined } from '@ant-design/icons';

import CVATTooltip from 'components/common/cvat-tooltip';
import { clamp } from 'utils/math';
import {
    MLModel, ModelKind, DimensionType, Label, LabelType,
} from 'cvat-core-wrapper';

import LabelsMapperComponent, { LabelInterface, FullMapping } from './labels-mapper';

interface Props {
    withCleanup: boolean;
    models: MLModel[];
    labels: Label[];
    dimension: DimensionType;
    runInference(model: MLModel, body: object): void;
}

type ServerMapping = Record<string, {
    name: string;
    attributes: Record<string, string>;
    sublabels?: ServerMapping;
}>;

export interface AnnotateTaskRequestBody {
    type: 'annotate_task';
    mapping: ServerMapping;
    cleanup: boolean;
    conv_mask_to_poly: boolean;
    threshold?: number;
    extra_params?: Record<string, unknown>;
}

function convertMappingToServer(mapping: FullMapping): ServerMapping {
    return mapping.reduce<ServerMapping>((acc, [modelLabel, taskLabel, attributesMapping, subMapping]) => (
        {
            ...acc,
            [modelLabel.name]: {
                name: taskLabel.name,
                attributes: attributesMapping.reduce<Record<string, string>>((attrAcc, val) => {
                    if (val[0]?.name && val[1]?.name) {
                        attrAcc[val[0].name] = val[1].name;
                    }
                    return attrAcc;
                }, {}),
                ...(subMapping.length ? { sublabels: convertMappingToServer(subMapping) } : {}),
            },
        }
    ), {});
}

function DetectorRunner(props: Props): JSX.Element {
    const {
        models, withCleanup, labels, dimension, runInference,
    } = props;

    const [modelID, setModelID] = useState<string | null>(null);
    const [threshold, setThreshold] = useState<number>(0.5);
    const [distance, setDistance] = useState<number>(50);
    const [cleanup, setCleanup] = useState<boolean>(false);
    const [mapping, setMapping] = useState<FullMapping>([]);
    const [convertMasksToPolygons, setConvertMasksToPolygons] = useState<boolean>(false);
    const [detectorThreshold, setDetectorThreshold] = useState<number | null>(null);
    const [modelLabels, setModelLabels] = useState<LabelInterface[]>([]);
    const [taskLabels, setTaskLabels] = useState<LabelInterface[]>([]);
    const [extraParams, setExtraParams] = useState<Record<string, unknown>>({});

    const model = models.find((_model): boolean => _model.id === modelID);
    const isDetector = model?.kind === ModelKind.DETECTOR;
    const isReId = model?.kind === ModelKind.REID;
    const convertMasks2PolygonVisible = isDetector &&
        [LabelType.ANY, LabelType.MASK].includes(model.returnType);

    const buttonEnabled = model && (isReId || (isDetector && mapping.length));

    // Reset extra params to schema defaults whenever the selected model changes
    useEffect(() => {
        const schema = model?.extraParamsSchema ?? [];
        if (schema.length > 0) {
            const defaults: Record<string, unknown> = {};
            schema.forEach((p: any) => {
                defaults[p.name] = p.default !== undefined ? p.default : null;
            });
            setExtraParams(defaults);
        } else {
            setExtraParams({});
        }
    }, [modelID]);

    useEffect(() => {
        const converted = labels.map((label) => ({
            name: label.name,
            type: label.type,
            color: label.color,
            attributes: label.attributes.map((attr) => ({
                name: attr.name,
                input_type: attr.inputType,
                values: [...attr.values],
            })),
            sublabels: (label.structure?.sublabels || []).map((sublabel) => ({
                name: sublabel.name,
                type: sublabel.type,
                color: sublabel.color,
                attributes: sublabel.attributes.map((attr) => ({
                    name: attr.name,
                    input_type: attr.inputType,
                    values: [...attr.values],
                })),
            })),
        }));

        setTaskLabels(converted);
        if (model) {
            setModelLabels(model.labels);
            if (!model.labels.length && model.kind !== ModelKind.REID) {
                notification.warning({ message: 'This model does not have specified labels' });
            }
        } else {
            setModelLabels([]);
        }
    }, [labels, model]);

    return (
        <div className='cvat-run-model-content'>
            <Row align='middle'>
                <Col span={4}>Model:</Col>
                <Col span={20}>
                    <Select
                        placeholder={dimension === DimensionType.DIMENSION_2D ? 'Select a model' : 'No models available'}
                        disabled={dimension !== DimensionType.DIMENSION_2D}
                        style={{ width: '100%' }}
                        onChange={(_modelID: string): void => {
                            setModelID(_modelID);
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
                        <div>
                            <Text strong>Setup mapping between labels and attributes</Text>
                        </div>
                        <div>
                            <Tag>Model Spec</Tag>
                            <ArrowRightOutlined />
                            <Tag>CVAT Spec</Tag>
                        </div>
                    </div>
                    <LabelsMapperComponent
                        key={modelID} // rerender when model switched
                        onUpdateMapping={(_mapping: FullMapping) => setMapping(_mapping)}
                        modelLabels={modelLabels}
                        taskLabels={taskLabels}
                    />
                </div>
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
                <div className='cvat-detector-runner-threshold-wrapper'>
                    <Row align='middle' justify='start'>
                        <Col>
                            <InputNumber
                                min={0.01}
                                step={0.01}
                                max={1}
                                value={detectorThreshold}
                                onChange={(value: number | null) => {
                                    setDetectorThreshold(value);
                                }}
                            />
                        </Col>
                        <Col>
                            <Text>Threshold</Text>
                            <CVATTooltip title='Minimum confidence threshold for detections. Leave empty to use the default value specified in the model settings'>
                                <QuestionCircleOutlined className='cvat-info-circle-icon' />
                            </CVATTooltip>
                        </Col>
                    </Row>
                </div>
            )}
            {isDetector && (model?.extraParamsSchema ?? []).length > 0 && (
                <div className='cvat-detector-runner-extra-params'>
                    <Divider orientation='left' plain style={{ marginTop: 8, marginBottom: 8 }}>
                        <Text strong>Model parameters</Text>
                    </Divider>
                    {(model?.extraParamsSchema ?? []).map((param: any) => {
                        const updateParam = (value: unknown): void => {
                            setExtraParams((prev) => ({ ...prev, [param.name]: value }));
                        };
                        const currentVal = extraParams[param.name];
                        return (
                            <Row
                                key={param.name}
                                align='middle'
                                justify='start'
                                style={{ marginBottom: 6 }}
                            >
                                <Col span={12}>
                                    <Text>{param.label ?? param.name}</Text>
                                    {param.description && (
                                        <CVATTooltip title={param.description}>
                                            <QuestionCircleOutlined className='cvat-info-circle-icon' />
                                        </CVATTooltip>
                                    )}
                                </Col>
                                <Col span={12}>
                                    {param.type === 'number' && (
                                        <InputNumber
                                            style={{ width: '100%' }}
                                            min={param.min}
                                            max={param.max}
                                            step={param.step ?? 1}
                                            value={currentVal as number | null}
                                            onChange={(v) => updateParam(v)}
                                        />
                                    )}
                                    {param.type === 'boolean' && (
                                        <Switch
                                            checked={!!currentVal}
                                            onChange={(checked) => updateParam(checked)}
                                        />
                                    )}
                                    {param.type === 'select' && (
                                        <Select
                                            style={{ width: '100%' }}
                                            value={currentVal as string}
                                            onChange={(v) => updateParam(v)}
                                        >
                                            {(param.options ?? []).map((opt: string) => (
                                                <Select.Option key={opt} value={opt}>
                                                    {opt}
                                                </Select.Option>
                                            ))}
                                        </Select>
                                    )}
                                    {param.type === 'number_list' && (
                                        <Select
                                            style={{ width: '100%' }}
                                            mode='tags'
                                            tokenSeparators={[',', ' ']}
                                            value={(currentVal as string[] | null) ?? []}
                                            onChange={(v) => updateParam(
                                                (v as string[]).map(Number).filter((n) => !Number.isNaN(n)),
                                            )}
                                            notFoundContent={null}
                                        />
                                    )}
                                </Col>
                            </Row>
                        );
                    })}
                </div>
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
                        disabled={!buttonEnabled}
                        type='primary'
                        onClick={() => {
                            if (!model) return;
                            const serverMapping = convertMappingToServer(mapping);
                            if (model.kind === ModelKind.DETECTOR) {
                                const nonNullExtraParams = Object.fromEntries(
                                    Object.entries(extraParams).filter(([, v]) => v !== null && v !== undefined),
                                );
                                const body: AnnotateTaskRequestBody = {
                                    type: 'annotate_task',
                                    mapping: serverMapping,
                                    cleanup,
                                    conv_mask_to_poly: convertMasksToPolygons,
                                    ...(detectorThreshold !== null ? { threshold: detectorThreshold } : {}),
                                    ...(Object.keys(nonNullExtraParams).length
                                        ? { extra_params: nonNullExtraParams }
                                        : {}),
                                };

                                runInference(model, body);
                            } else if (model.kind === ModelKind.REID) {
                                runInference(model, { threshold, max_distance: distance });
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

export default React.memo(DetectorRunner);
