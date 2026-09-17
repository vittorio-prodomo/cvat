// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT

export interface CleanImageOverlayRoots {
    text: SVGElement;
    masks: HTMLElement;
    bitmap: HTMLElement;
    grid: SVGElement;
    content: SVGElement;
    attachments: HTMLElement;
}

const savedVisibility = new WeakMap<Element, string>();

export function applyCleanImageMode(roots: CleanImageOverlayRoots, enabled: boolean): void {
    // Keep the content SVG as the event plane for pan and ROI zoom.
    roots.content.classList.toggle('cvat_canvas_clean_image', enabled);
    for (const root of [
        roots.text,
        roots.masks,
        roots.bitmap,
        roots.grid,
        roots.attachments,
    ]) {
        if (enabled) {
            if (!savedVisibility.has(root)) savedVisibility.set(root, root.style.visibility);
            root.style.visibility = 'hidden';
        } else if (savedVisibility.has(root)) {
            root.style.visibility = savedVisibility.get(root) as string;
            savedVisibility.delete(root);
        }
    }
}
