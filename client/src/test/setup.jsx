import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom does not implement modal dialogs.
if (typeof HTMLDialogElement !== "undefined") {
    if (!HTMLDialogElement.prototype.showModal) {
        HTMLDialogElement.prototype.showModal = function showModal() {
            this.open = true;
        };
    }
    if (!HTMLDialogElement.prototype.close) {
        HTMLDialogElement.prototype.close = function close(returnValue) {
            if (returnValue !== undefined) this.returnValue = returnValue;
            this.open = false;
            this.dispatchEvent(new Event("close"));
        };
    }
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete window.nativeMessageService;
    delete window.navigator.platform;
    window.sessionStorage.clear();
});
