import { waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { renderApp, stubFetch } from "../../test/utils";

const savedOrder = {
    orderRefId: "MBB777", partnerReferenceId: "REF777", partnerInvoiceId: "INV15486272711",
    currency: "MYR", amount: 100, createdAt: "2026-07-17T07:29:55.000Z", paymentStatus: "PENDING"
};

async function loadPage(search, fetchResult = { ok: true, success: true, data: savedOrder }, path = "/paymentstatus") {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = stubFetch(async () => {
        if (fetchResult instanceof Error) throw fetchResult;
        return { ok: fetchResult.ok, async json() { return fetchResult; } };
    });
    const view = renderApp(path + search);
    const byId = id => document.getElementById(id);
    await waitFor(() => {
        const message = byId("message");
        expect(message.hidden || message.textContent !== "Loading order details...").toBe(true);
    });
    return { ...view, byId, errors, requests: () => fetch.mock.calls.map(([url]) => url) };
}

test("payment page uses orderRefId and displays database values, not URL status or invoice", async () => {
    const { byId, requests } = await loadPage("?orderRefId=MBB777&partnerInvoiceId=untrusted&status=SUCCESS&amount=999");
    expect(requests()).toEqual(["/api/local/orders/MBB777"]);
    for (const field of ["orderRefId", "partnerReferenceId", "partnerInvoiceId", "paymentStatus"]) {
        expect(byId(field).textContent).toBe(savedOrder[field]);
    }
    expect(byId("amount").textContent).toBe("MYR 100");
    expect(byId("createdAt").textContent).toBe("2026-07-17");
    expect(byId("createdAt")).toHaveAttribute("datetime", savedOrder.createdAt);
    expect(byId("orderDetails")).not.toHaveAttribute("hidden");
    expect(byId("detailsHeading")).not.toHaveAttribute("hidden");
    expect(byId("message")).toHaveAttribute("hidden");
});

test("payment page uses orderRefId unchanged for success and failed redirects and the .html path", async () => {
    for (const [path, search, expectedRef] of [
        ["/paymentstatus", "?orderRefId=MBB977&status=FAILED", "MBB977"],
        ["/paymentstatus", "?orderRefId=MBB977&status=SUCCESS", "MBB977"],
        ["/paymentstatus.html", "?orderRefId=MBB777", "MBB777"],
        ["/paymentstatus", "?orderRefId=777", "777"],
        ["/paymentstatus", "?orderRefId=MBB777&orderId=999&oid=888", "MBB777"]
    ]) {
        const { requests, unmount } = await loadPage(search, undefined, path);
        expect(requests()).toEqual(["/api/local/orders/" + expectedRef]);
        unmount();
    }
});

test("payment page colors successful and failed, rejected or cancelled statuses while preserving pending", async () => {
    for (const [status, expectedClass] of [
        ["PENDING", undefined],
        ["SUCCESS", "status-success"],
        ["FAIL", "status-error"],
        ["FAILED", "status-error"],
        [" failed ", "status-error"],
        ["REJECT", "status-error"],
        ["CANCEL", "status-error"]
    ]) {
        const { byId, unmount } = await loadPage("?orderRefId=MBB777", {
            ok: true, success: true, data: { ...savedOrder, paymentStatus: status }
        });
        const classes = byId("paymentStatus").classList;
        expect(classes.contains("status-success")).toBe(expectedClass === "status-success");
        expect(classes.contains("status-error")).toBe(expectedClass === "status-error");
        unmount();
    }
});

test("payment page shows missing ID errors without fetching", async () => {
    for (const search of ["", "?orderRefId=null", "?orderRefId=undefined", "?orderRefId=%20", "?orderId=777", "?oid=MBB777"]) {
        const { requests, byId, unmount } = await loadPage(search);
        expect(requests()).toEqual([]);
        expect(byId("message").textContent).toBe("An orderRefId is required to load payment details.");
        expect(byId("message")).toHaveClass("error");
        expect(byId("orderDetails")).toHaveAttribute("hidden");
        unmount();
    }
});

test("payment page shows not found and network errors without displaying payment success", async () => {
    for (const result of [
        { ok: false, success: false, message: "Order not found" },
        new Error("Network unavailable")
    ]) {
        const { byId, errors, unmount } = await loadPage("?orderRefId=MBB777&status=SUCCESS", result);
        expect(byId("message").textContent).toBe(result.message);
        expect(byId("message")).toHaveClass("error");
        expect(byId("orderDetails")).toHaveAttribute("hidden");
        expect(errors).toHaveBeenCalledTimes(1);
        unmount();
        errors.mockRestore();
    }
});
