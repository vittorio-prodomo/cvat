// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import type React from 'react';

const pendingSubmissions = new WeakSet<HTMLElement>();

function visible(element: HTMLElement): boolean {
    const style = window.getComputedStyle(element);
    return element.isConnected && element.getClientRects().length > 0 &&
        !element.closest('[hidden], [aria-hidden="true"], .ant-tabs-tabpane-hidden, .ant-popover-hidden') &&
        style.visibility !== 'hidden' && style.pointerEvents !== 'none';
}

function available(button: HTMLButtonElement): boolean {
    return visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true' &&
        button.getAttribute('aria-busy') !== 'true' && !button.classList.contains('ant-btn-loading');
}

export default function primaryActionOnEnter(event: React.KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Enter' || event.defaultPrevented || event.repeat ||
        event.ctrlKey || event.altKey || event.shiftKey || event.metaKey ||
        event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
        return;
    }

    const { currentTarget: scope, target } = event;
    if (!(target instanceof HTMLElement) || !scope.contains(target) || !visible(target) ||
        !target.matches('input, textarea') ||
        target.matches('[type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"]') ||
        target.closest('.ant-select, [role="combobox"]')) {
        return;
    }

    const button = Array.from(scope.querySelectorAll<HTMLButtonElement>('button[data-primary-action]'))
        .find(available);
    if (!button) return;

    event.preventDefault();
    event.stopPropagation();
    if (pendingSubmissions.has(scope)) return;
    pendingSubmissions.add(scope);

    // Match a mouse click: commit InputNumber/ROI edits on blur, then allow
    // React's state updates to render before the button reads their values.
    target.blur();
    window.setTimeout(() => {
        pendingSubmissions.delete(scope);
        if (scope.contains(button) && available(button)) button.click();
    }, 0);
}
