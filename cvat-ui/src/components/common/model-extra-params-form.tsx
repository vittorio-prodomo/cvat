// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React from 'react';
import { Row, Col } from 'antd/lib/grid';
import Select from 'antd/lib/select';
import Text from 'antd/lib/typography/Text';
import InputNumber from 'antd/lib/input-number';
import Switch from 'antd/lib/switch';
import Divider from 'antd/lib/divider';
import { QuestionCircleOutlined } from '@ant-design/icons';

import CVATTooltip from 'components/common/cvat-tooltip';
import { clamp } from 'utils/math';

export interface ModelExtraParamSchemaItem {
    name: string;
    type: 'number' | 'boolean' | 'select' | 'number_list';
    label?: string;
    description?: string;
    default?: unknown;
    min?: number;
    max?: number;
    step?: number;
    options?: string[];
}

export function buildExtraParamsDefaults(schema: ModelExtraParamSchemaItem[]): Record<string, unknown> {
    const defaults: Record<string, unknown> = {};
    schema.forEach((param) => {
        defaults[param.name] = param.default !== undefined ? param.default : null;
    });
    return defaults;
}

interface ModelExtraParamsFormProps {
    schema: ModelExtraParamSchemaItem[];
    values: Record<string, unknown>;
    onChange: (values: Record<string, unknown>) => void;
    title?: string;
}

function ModelExtraParamsForm(props: ModelExtraParamsFormProps): JSX.Element | null {
    const {
        schema, values, onChange, title = 'Model parameters',
    } = props;

    if (schema.length === 0) {
        return null;
    }

    const updateParam = (name: string, value: unknown): void => {
        onChange({ ...values, [name]: value });
    };

    return (
        <div className='cvat-model-extra-params'>
            <Divider orientation='left' plain style={{ marginTop: 8, marginBottom: 8 }}>
                <Text strong>{title}</Text>
            </Divider>
            {schema.map((param) => {
                const currentVal = values[param.name];
                return (
                    <Row
                        key={param.name}
                        align='middle'
                        justify='start'
                        className='cvat-model-extra-params-row'
                    >
                        <Col span={12}>
                            <Text>{param.label ?? param.name}</Text>
                            {param.description && (
                                <CVATTooltip title={param.description}>
                                    <QuestionCircleOutlined className='cvat-model-extra-params-tooltip-icon' />
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
                                    onChange={(v) => {
                                        if (typeof v !== 'number' || Number.isNaN(v)) {
                                            return;
                                        }
                                        const clamped = param.min !== undefined && param.max !== undefined ?
                                            clamp(v, param.min, param.max) :
                                            v;
                                        updateParam(param.name, clamped);
                                    }}
                                />
                            )}
                            {param.type === 'boolean' && (
                                <Switch
                                    checked={!!currentVal}
                                    onChange={(checked) => updateParam(param.name, checked)}
                                />
                            )}
                            {param.type === 'select' && (
                                <Select
                                    style={{ width: '100%' }}
                                    value={currentVal as string}
                                    onChange={(v) => updateParam(param.name, v)}
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
                                        param.name,
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
    );
}

export default ModelExtraParamsForm;
