import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAutoMappingEntry } from '../../cvat-ui/src/components/model-runner-modal/label-mapping-initialization.ts';

test('builds label, attribute, and skeleton mappings in one value', () => {
    const model = {
        name: 'C2', type: 'skeleton', attributes: [{ name: 'model_confidence', values: [], input_type: 'text' }],
        sublabels: [{
            name: 'corner', type: 'points',
            attributes: [{ name: 'visibility', values: [], input_type: 'text' }],
        }],
    };
    const task = {
        name: 'C2_effloresc', type: 'skeleton', attributes: [{ name: 'model_confidence', values: [], input_type: 'text' }],
        sublabels: [{
            name: 'corner', type: 'points',
            attributes: [{ name: 'visibility', values: [], input_type: 'text' }],
        }],
    };

    const entry = buildAutoMappingEntry(model, task, (left, right) => (
        left.flatMap((source) => right.filter((target) => source.name === target.name).map((target) => [source, target]))
    ));

    assert.equal(entry[2][0][0]?.name, 'model_confidence');
    assert.equal(entry[2][0][1]?.name, 'model_confidence');
    assert.equal(entry[3][0][2][0][0]?.name, 'visibility');
    assert.equal(entry[3][0][2][0][1]?.name, 'visibility');
});
