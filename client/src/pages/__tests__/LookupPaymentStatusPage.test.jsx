import { waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { pageStyles, renderApp, stubFetch } from "../../test/utils";

const savedOrder = {
    orderRefId: "MBB814", partnerReferenceId: "REF20260522", partnerInvoiceId: "INV62494506123",
    currency: "MYR", amount: 100, createdAt: "2026-10-25T01:00:00.000Z", paymentStatus: "PENDING"
};

function loadPage(stored = JSON.stringify(savedOrder)) {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = stubFetch(() => { throw new Error("The lookup status screen must not make API requests"); });
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(key => {
        expect(key).toBe("lookupPaymentStatus");
        if (stored instanceof Error) throw stored;
        return stored;
    });
    const view = renderApp("/lookup-payment-status.html");
    const byId = id => document.getElementById(id);
    return { ...view, byId, errors, fetch, getItem };
}

test("lookup receipt displays response values without another API call and survives reload", () => {
    for (let reload = 0; reload < 2; reload++) {
        const { byId, errors, fetch, unmount } = loadPage();
        for (const field of ["orderRefId", "partnerReferenceId", "partnerInvoiceId", "paymentStatus"]) {
            expect(byId(field).textContent).toBe(savedOrder[field]);
        }
        expect(byId("amount").textContent).toBe("MYR 100");
        expect(byId("createdAt").textContent).toBe("2026-10-25");
        expect(byId("createdAt")).toHaveAttribute("datetime", savedOrder.createdAt);
        expect(byId("orderDetails")).not.toHaveAttribute("hidden");
        expect(byId("detailsHeading")).not.toHaveAttribute("hidden");
        expect(byId("message")).toHaveAttribute("hidden");
        expect(errors).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        unmount();
    }
});

test("lookup receipt maps DP aliases, renders text safely and preserves zero amounts", () => {
    const { byId } = loadPage(JSON.stringify({
        orderId: "MBB9", ParnerRefNumber: "<script>alert(1)</script>",
        PartnerInvoice: "INV9", PaymentStatus: "FAILED", currency: "MYR", amount: 0
    }));
    expect(byId("orderRefId").textContent).toBe("MBB9");
    expect(byId("partnerReferenceId").textContent).toBe("<script>alert(1)</script>");
    expect(byId("partnerReferenceId").querySelector("script")).toBeNull();
    expect(byId("partnerInvoiceId").textContent).toBe("INV9");
    expect(byId("paymentStatus").textContent).toBe("FAILED");
    expect(byId("amount").textContent).toBe("MYR 0");
});

test("lookup receipt colors successful and failed, rejected or cancelled statuses while preserving pending", () => {
    for (const [status, expectedClass] of [
        ["PENDING", undefined],
        ["SUCCESS", "status-success"],
        ["FAIL", "status-error"],
        ["FAILED", "status-error"],
        [" failed ", "status-error"],
        ["REJECT", "status-error"],
        ["CANCEL", "status-error"]
    ]) {
        const { byId, unmount } = loadPage(JSON.stringify({ ...savedOrder, paymentStatus: status }));
        const classes = byId("paymentStatus").classList;
        expect(classes.contains("status-success")).toBe(expectedClass === "status-success");
        expect(classes.contains("status-error")).toBe(expectedClass === "status-error");
        unmount();
    }
});

test("missing and invalid fields are not replaced with fabricated payment values", () => {
    for (const fields of [{}, { createdAt: "invalid", amount: {}, paymentStatus: {} }]) {
        const { byId, unmount } = loadPage(JSON.stringify({ orderRefId: "MBB1", ...fields }));
        for (const field of ["partnerReferenceId", "partnerInvoiceId", "paymentStatus", "amount", "createdAt"]) {
            expect(byId(field).textContent).toBe("Not provided");
        }
        expect(byId("createdAt")).not.toHaveAttribute("datetime");
        unmount();
    }
});

test("missing, malformed or inaccessible saved results show an explicit error", () => {
    for (const stored of [null, "null", "[]", "{}", '{"orderRefId":" "}', "invalid", new Error("Storage unavailable")]) {
        const { byId, errors, unmount } = loadPage(stored);
        expect(byId("message")).not.toHaveAttribute("hidden");
        expect(byId("message")).toHaveClass("error");
        expect(byId("message").textContent).toBeTruthy();
        expect(byId("orderDetails")).toHaveAttribute("hidden");
        expect(byId("detailsHeading")).toHaveAttribute("hidden");
        expect(byId("orderRefId").textContent).toBe("");
        expect(errors).toHaveBeenCalledTimes(1);
        unmount();
        errors.mockRestore();
    }
});

const receipt = () => document.querySelector("main").outerHTML
    .replace(/Loading (?:order|lookup) details/, "Loading details");

test("both status screens share the same receipt markup and responsive styling, not functionality", async () => {
    const lookup = loadPage();
    const lookupReceipt = receipt();
    const lookupCss = pageStyles();
    expect(lookup.fetch).not.toHaveBeenCalled();
    lookup.unmount();
    vi.restoreAllMocks();

    stubFetch(async () => ({ ok: true, async json() { return { success: true, data: savedOrder }; } }));
    const status = renderApp("/paymentstatus?orderId=MBB814");
    await waitFor(() => expect(document.getElementById("orderDetails")).not.toHaveAttribute("hidden"));
    expect(receipt()).toBe(lookupReceipt);
    expect(pageStyles()).toBe(lookupCss);
    status.unmount();

    expect(lookupCss).toMatch(/@media \(max-width: 520px\)/);
    expect(lookupCss).toMatch(/\[hidden\] \{ display: none !important; \}/);
});
