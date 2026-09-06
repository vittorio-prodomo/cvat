import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DEFAULT_DETECTOR_RUN_OPTIONS,
    buildDetectorRequestThreshold,
    isDetectorThresholdInputValid,
    isPostprocessingThresholdInputValid,
    isPostprocessingThresholdValid,
    parseDetectorThresholdInput,
} from '../../cvat-ui/src/components/model-runner-modal/detector-runner-config.ts';

test('preview and postprocessing defaults are independent', () => {
    assert.deepEqual(DEFAULT_DETECTOR_RUN_OPTIONS, {
        previewConfidence: true,
        postprocessing: { method: 'nms', metric: 'ios', threshold: 0.8 },
    });
    assert.equal(buildDetectorRequestThreshold(true, null), 0.1);
    assert.equal(buildDetectorRequestThreshold(false, null), null);
    assert.equal(buildDetectorRequestThreshold(false, 0.62), 0.62);
    assert.equal(isPostprocessingThresholdValid('nms', 0), true);
    assert.equal(isPostprocessingThresholdValid('nms', 1), true);
    assert.equal(isPostprocessingThresholdValid('nms', null), false);
    assert.equal(isPostprocessingThresholdValid('nms', Number.NaN), false);
    assert.equal(isPostprocessingThresholdValid('nms', -0.01), false);
    assert.equal(isPostprocessingThresholdValid('nms', 1.01), false);
    assert.equal(isPostprocessingThresholdValid('disabled', null), true);
});

test('uses the raw validator grammar for the numeric input parser', () => {
    assert.equal(parseDetectorThresholdInput('0.8'), '0.8');
    assert.equal(parseDetectorThresholdInput('7e-1'), '7e-1');
    assert.equal(parseDetectorThresholdInput(''), '');
    assert.equal(parseDetectorThresholdInput('+0.8'), 'NaN');
    assert.equal(parseDetectorThresholdInput('8E-1'), 'NaN');
    assert.equal(parseDetectorThresholdInput('0.8x'), 'NaN');
});

test('validates the displayed confidence input instead of a stale numeric value', () => {
    assert.equal(isDetectorThresholdInputValid(''), true);
    assert.equal(isDetectorThresholdInputValid('0.01'), true);
    assert.equal(isDetectorThresholdInputValid('1e-1'), true);
    assert.equal(isDetectorThresholdInputValid('1'), true);
    assert.equal(isDetectorThresholdInputValid('+0.8'), false);
    assert.equal(isDetectorThresholdInputValid('8E-1'), false);
    assert.equal(isDetectorThresholdInputValid('0'), false);
    assert.equal(isDetectorThresholdInputValid('1.01'), false);
    assert.equal(isDetectorThresholdInputValid('0.62x'), false);
});

test('validates the displayed overlap input unless postprocessing is disabled', () => {
    assert.equal(isPostprocessingThresholdInputValid('nms', '0'), true);
    assert.equal(isPostprocessingThresholdInputValid('nms', '.7'), true);
    assert.equal(isPostprocessingThresholdInputValid('nms', '7e-1'), true);
    assert.equal(isPostprocessingThresholdInputValid('nms', '1'), true);
    assert.equal(isPostprocessingThresholdInputValid('nms', '+0.8'), false);
    assert.equal(isPostprocessingThresholdInputValid('nms', '8E-1'), false);
    assert.equal(isPostprocessingThresholdInputValid('nms', ''), false);
    assert.equal(isPostprocessingThresholdInputValid('nms', '-'), false);
    assert.equal(isPostprocessingThresholdInputValid('nms', '.'), false);
    assert.equal(isPostprocessingThresholdInputValid('nms', '-0.01'), false);
    assert.equal(isPostprocessingThresholdInputValid('nms', '1.01'), false);
    assert.equal(isPostprocessingThresholdInputValid('nms', '0.7x'), false);
    assert.equal(isPostprocessingThresholdInputValid('disabled', ''), true);
    assert.equal(isPostprocessingThresholdInputValid('disabled', 'invalid'), true);
});
