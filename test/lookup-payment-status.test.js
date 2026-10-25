const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "../public");
const script = fs.readFileSync(path.join(root, "lookup-payment-status.js"), "utf8");
const savedOrder = {
    orderRefId: "MBB814", partnerReferenceId: "REF20260522", partnerInvoiceId: "INV62494506123",
    currency: "MYR", amount: 100, createdAt: "2026-10-25T01:00:00.000Z", paymentStatus: "PENDING"
};

function loadPage(stored = JSON.stringify(savedOrder)) {
    const elements = new Map();
    const errors = [];
    vm.runInNewContext(script, {
        window: { sessionStorage: { getItem(key) {
            assert.equal(key, "lookupPaymentStatus");
            if (stored instanceof Error) throw stored;
            return stored;
        } } },
        document: { getElementById(id) {
            if (!elements.has(id)) elements.set(id, {
                textContent: "", hidden: ["orderDetails", "detailsHeading"].includes(id),
                classList: { add(value) { this[value] = true; } }
            });
            return elements.get(id);
        } },
        fetch() { assert.fail("The lookup status screen must not make API requests"); },
        console: { error: (...args) => errors.push(args) }
    });
    return { elements, errors };
}

test("lookup receipt displays response values without another API call and survives reload", () => {
    for (let reload = 0; reload < 2; reload++) {
        const { elements, errors } = loadPage();
        for (const field of ["orderRefId", "partnerReferenceId", "partnerInvoiceId", "paymentStatus"]) {
            assert.equal(elements.get(field).textContent, savedOrder[field]);
        }
        assert.equal(elements.get("amount").textContent, "MYR 100");
        assert.equal(elements.get("createdAt").textContent, "2026-10-25");
        assert.equal(elements.get("createdAt").dateTime, savedOrder.createdAt);
        assert.equal(elements.get("orderDetails").hidden, false);
        assert.equal(elements.get("detailsHeading").hidden, false);
        assert.equal(elements.get("message").hidden, true);
        assert.equal(errors.length, 0);
    }
});

test("lookup receipt maps DP aliases, renders text safely and preserves zero amounts", () => {
    const { elements } = loadPage(JSON.stringify({
        orderId: "MBB9", ParnerRefNumber: "<script>alert(1)</script>",
        PartnerInvoice: "INV9", PaymentStatus: "FAILED", currency: "MYR", amount: 0
    }));
    assert.equal(elements.get("orderRefId").textContent, "MBB9");
    assert.equal(elements.get("partnerReferenceId").textContent, "<script>alert(1)</script>");
    assert.equal(elements.get("partnerInvoiceId").textContent, "INV9");
    assert.equal(elements.get("paymentStatus").textContent, "FAILED");
    assert.equal(elements.get("amount").textContent, "MYR 0");
});

test("lookup receipt colors successful and rejected or cancelled statuses while preserving pending", () => {
    for (const [status, expectedClass] of [
        ["PENDING", undefined],
        ["SUCCESS", "status-success"],
        ["REJECT", "status-error"],
        ["CANCEL", "status-error"]
    ]) {
        const { elements } = loadPage(JSON.stringify({ ...savedOrder, paymentStatus: status }));
        const classes = elements.get("paymentStatus").classList;
        assert.equal(Boolean(classes["status-success"]), expectedClass === "status-success");
        assert.equal(Boolean(classes["status-error"]), expectedClass === "status-error");
    }
});

test("missing and invalid fields are not replaced with fabricated payment values", () => {
    for (const fields of [{}, { createdAt: "invalid", amount: {}, paymentStatus: {} }]) {
        const { elements } = loadPage(JSON.stringify({ orderRefId: "MBB1", ...fields }));
        for (const field of ["partnerReferenceId", "partnerInvoiceId", "paymentStatus", "amount", "createdAt"]) {
            assert.equal(elements.get(field).textContent, "Not provided");
        }
        assert.equal(elements.get("createdAt").dateTime, undefined);
    }
});

test("missing, malformed or inaccessible saved results show an explicit error", () => {
    for (const stored of [null, "null", "[]", "{}", '{"orderRefId":" "}', "invalid", new Error("Storage unavailable")]) {
        const { elements, errors } = loadPage(stored);
        assert.equal(elements.get("message").hidden, false);
        assert.equal(elements.get("message").classList.error, true);
        assert.ok(elements.get("message").textContent);
        assert.equal(elements.get("orderDetails"), undefined);
        assert.equal(errors.length, 1);
    }
});

test("both status screens share the same receipt markup and responsive styling, not functionality", () => {
    const original = fs.readFileSync(path.join(root, "paymentstatus.html"), "utf8");
    const lookup = fs.readFileSync(path.join(root, "lookup-payment-status.html"), "utf8");
    for (const html of [original, lookup]) {
        assert.match(html, /href="\/payment-status.css"/);
    }
    const receipt = html => html.match(/<main[\s\S]*?<\/main>/)[0]
        .replace(/Loading (?:order|lookup) details/, "Loading details");
    assert.equal(receipt(lookup), receipt(original));
    assert.match(lookup, /src="\/lookup-payment-status.js" defer/);
    assert.doesNotMatch(lookup, /fetch\(|payment-session/);
    const css = fs.readFileSync(path.join(root, "payment-status.css"), "utf8");
    assert.match(css, /@media \(max-width: 520px\)/);
    assert.match(css, /\[hidden\] \{ display: none !important; \}/);
});
