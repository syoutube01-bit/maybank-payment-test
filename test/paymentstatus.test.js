const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "paymentstatus.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const savedOrder = {
    orderRefId: "MBB777", partnerReferenceId: "REF777", partnerInvoiceId: "INV15486272711",
    currency: "MYR", amount: 100, createdAt: "2026-07-17T07:29:55.000Z", paymentStatus: "PENDING"
};

async function loadPage(search, fetchResult = { ok: true, success: true, data: savedOrder }) {
    const elements = new Map();
    const requests = [];
    const errors = [];
    let ready;
    const context = vm.createContext({
        URLSearchParams,
        window: {
            location: { search },
            addEventListener(event, handler) { ready = handler; }
        },
        document: {
            getElementById(id) {
                if (!elements.has(id)) {
                    elements.set(id, {
                        textContent: "", hidden: id === "orderDetails",
                        classList: { add(value) { this[value] = true; } }
                    });
                }
                return elements.get(id);
            }
        },
        async fetch(url) {
            requests.push(url);
            if (fetchResult instanceof Error) throw fetchResult;
            return { ok: fetchResult.ok, async json() { return fetchResult; } };
        },
        console: { error: (...args) => errors.push(args) }
    });
    vm.runInContext(script, context);
    await ready();
    return { elements, requests, errors };
}

test("payment page prefixes orderId and displays database values, not URL status or invoice", async () => {
    const { elements, requests } = await loadPage(
        "?orderId=777&partnerInvoiceId=untrusted&status=SUCCESS&amount=999"
    );
    assert.deepEqual(requests, ["/api/local/orders/MBB777"]);
    for (const field of ["orderRefId", "partnerReferenceId", "partnerInvoiceId", "paymentStatus"]) {
        assert.equal(elements.get(field).textContent, savedOrder[field]);
    }
    assert.equal(elements.get("amount").textContent, "MYR 100");
    assert.equal(elements.get("createdAt").textContent, "2026-07-17");
    assert.equal(elements.get("createdAt").dateTime, savedOrder.createdAt);
    assert.equal(elements.get("orderDetails").hidden, false);
    assert.equal(elements.get("message").hidden, true);
});

test("payment page supports existing oid links and does not double-prefix MBB", async () => {
    for (const search of ["?oid=MBB777", "?orderId=MBB777", "?oid=777"]) {
        const { requests } = await loadPage(search);
        assert.deepEqual(requests, ["/api/local/orders/MBB777"]);
    }
});

test("payment page colors successful and rejected or cancelled statuses while preserving pending", async () => {
    for (const [status, expectedClass] of [
        ["PENDING", undefined],
        ["SUCCESS", "status-success"],
        ["REJECT", "status-error"],
        ["CANCEL", "status-error"]
    ]) {
        const { elements } = await loadPage("?orderId=777", {
            ok: true, success: true, data: { ...savedOrder, paymentStatus: status }
        });
        const classes = elements.get("paymentStatus").classList;
        assert.equal(Boolean(classes["status-success"]), expectedClass === "status-success");
        assert.equal(Boolean(classes["status-error"]), expectedClass === "status-error");
    }
});

test("payment page shows missing ID errors without fetching", async () => {
    for (const search of ["", "?orderId=null", "?orderId=undefined", "?orderId=%20"]) {
        const { requests, elements } = await loadPage(search);
        assert.deepEqual(requests, []);
        assert.equal(elements.get("message").textContent, "An orderId is required to load payment details.");
        assert.equal(elements.get("message").classList.error, true);
        assert.equal(elements.get("orderDetails").hidden, true);
    }
});

test("payment page shows not found and network errors without displaying payment success", async () => {
    for (const result of [
        { ok: false, success: false, message: "Order not found" },
        new Error("Network unavailable")
    ]) {
        const { elements, errors } = await loadPage("?orderId=777&status=SUCCESS", result);
        assert.equal(elements.get("message").textContent, result.message);
        assert.equal(elements.get("message").classList.error, true);
        assert.equal(elements.get("orderDetails").hidden, true);
        assert.equal(errors.length, 1);
    }
});
