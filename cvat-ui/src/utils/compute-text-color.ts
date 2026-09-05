// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

export function computeTextColor(backgroundHex: string): string {
    if (!/^#[0-9a-fA-F]{6}$/.test(backgroundHex)) {
        return '#ffffff';
    }

    const channels = [1, 3, 5].map((offset: number): number => (
        parseInt(backgroundHex.slice(offset, offset + 2), 16) / 255
    )).map((channel: number): number => (
        channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    ));
    const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    const blackContrast = (luminance + 0.05) / 0.05;
    const whiteContrast = 1.05 / (luminance + 0.05);

    return blackContrast >= whiteContrast ? '#000000' : '#ffffff';
}
