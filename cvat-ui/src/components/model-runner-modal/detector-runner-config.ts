export type DetectorPostprocessingMethod = 'disabled' | 'nms' | 'nmm' | 'greedy_nmm';
export type DetectorOverlapMetric = 'iou' | 'ios';

export interface DetectorPostprocessingOptions {
    method: DetectorPostprocessingMethod;
    metric: DetectorOverlapMetric;
    threshold: number;
    labelGroups?: number[][];
}

export interface DetectorRunOptions {
    previewConfidence: boolean;
    postprocessing: DetectorPostprocessingOptions;
}

export const DEFAULT_DETECTOR_RUN_OPTIONS: DetectorRunOptions = Object.freeze({
    previewConfidence: true,
    postprocessing: Object.freeze({ method: 'nms', metric: 'ios', threshold: 0.7 }),
});

export function buildDetectorRequestThreshold(preview: boolean, explicit: number | null): number | null {
    return preview ? 0.1 : explicit;
}

function containsOnlyDigits(input: string): boolean {
    return !!input && Array.from(input).every((character) => character >= '0' && character <= '9');
}

function isDecimal(input: string): boolean {
    const unsigned = input.startsWith('-') ? input.slice(1) : input;
    const parts = unsigned.split('.');
    return parts.length <= 2 && parts.some(containsOnlyDigits) && parts.every((part) => (
        !part || containsOnlyDigits(part)
    ));
}

export function parseDetectorThresholdInput(input: string | undefined): string {
    const normalized = input?.trim() ?? '';
    if (!normalized) {
        return '';
    }

    const scientificParts = normalized.split('e');
    const exponent = scientificParts[1];
    const unsignedExponent = exponent && ['-', '+'].includes(exponent[0]) ? exponent.slice(1) : exponent;
    const validScientific = scientificParts.length <= 2 && isDecimal(scientificParts[0]) && (
        exponent === undefined || containsOnlyDigits(unsignedExponent)
    );
    return validScientific ? normalized : 'NaN';
}

function parseNumericInput(input: string): number | null {
    const parsed = parseDetectorThresholdInput(input);
    if (!parsed) {
        return null;
    }

    const value = Number(parsed);
    return Number.isFinite(value) ? value : null;
}

export function isDetectorThresholdInputValid(input: string): boolean {
    if (!input.trim()) {
        return true;
    }

    const threshold = parseNumericInput(input);
    return threshold !== null && threshold >= 0.01 && threshold <= 1;
}

export function isPostprocessingThresholdValid(
    method: DetectorPostprocessingMethod,
    threshold: number | null,
): boolean {
    return method === 'disabled' ||
        (typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 0 && threshold <= 1);
}

export function isPostprocessingThresholdInputValid(
    method: DetectorPostprocessingMethod,
    input: string,
): boolean {
    return isPostprocessingThresholdValid(method, parseNumericInput(input));
}
