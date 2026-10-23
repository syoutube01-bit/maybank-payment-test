const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function response(data, status = 200) {
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data) };
}

function loadPage({
    ordersFetch = async () => response({ success: true, data: [] }),
    clearFetch = async () => response({ success: true, deletedCount: 0 }),
    search = "?source=test"
} = {}) {
    const requests = [];
    const listeners = new Map();
    const elements = new Map();

    function createElement() {
        return {
            textContent: "", hidden: true, children: [],
            appendChild(child) { this.children.push(child); },
            replaceChildren() { this.children = []; }
        };
    }

    const window = { location: { search, href: "" } };
    const context = vm.createContext({
        document: {
            getElementById(id) {
                if (!elements.has(id)) {
                    const element = createElement();
                    element.disabled = false;
                    element.addEventListener = (event, handler) => listeners.set(id, handler);
                    if (id === "clearDbDialog") {
                        element.open = false;
                        element.showModal = () => { element.open = true; };
                        element.close = () => { element.open = false; };
                    }
                    elements.set(id, element);
                }
                return elements.get(id);
            },
            createElement,
            createDocumentFragment: createElement
        },
        window,
        async fetch(url, options) {
            requests.push({ url, options });
            if (url === "/api/local/orders") return ordersFetch();
            if (url === "/api/local/orders/clear") return clearFetch();
            throw new Error("Unexpected request: " + url);
        }
    });
    vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
    return {
        click(id) {
            const listener = listeners.get(id);
            assert.equal(typeof listener, "function", `No click listener for ${id}`);
            return listener();
        },
        requests, elements, window
    };
}

test("home page keeps payment navigation and provides database controls", () => {
    assert.match(html, /<button id="getFromDbBtn">Get from DB<\/button>/);
    assert.match(html, /<button id="clearDbBtn">Clear DB<\/button>/);
    assert.match(html, /<dialog[^>]*aria-labelledby="clearDbTitle"[^>]*aria-describedby="clearDbWarning"/);
    assert.doesNotMatch(html, /window\.confirm/);

    const page = loadPage();
    page.elements.get("dpBtn").onclick();
    assert.equal(page.window.location.href, "/DPLandingScreen.html?source=test");
    page.elements.get("pntBtn").onclick();
    assert.equal(page.window.location.href, "/PNTOrderCreation.html?source=test");
});

test("Get from DB renders all columns as text without requesting a token", async () => {
    const order = {
        orderRefId: "<script>alert(1)</script>", partnerReferenceId: "REF1",
        partnerInvoiceId: "INV1", currency: "MYR", amount: 100,
        createdAt: "2026-10-23", paymentStatus: "PENDING", orderStatus: "CREATED",
        partnerCode: "PAT001", partnerName: "PAT001 Demo Partner",
        PartnerInvoice: "INV1", ParnerRefNumber: "REF1",
        statusDescription: "Payment completed successfully",
        completedDateTime: "2026-10-23T07:29:55Z", PaymentStatusCode: "0000"
    };
    const page = loadPage({ ordersFetch: async () => response({ success: true, data: [order] }) });
    await page.click("getFromDbBtn");
    assert.deepEqual(page.requests.map(request => request.url), ["/api/local/orders"]);
    const rows = page.elements.get("dbOrdersBody").children[0].children;
    assert.deepEqual(rows[0].children.map(cell => cell.textContent), Object.values(order));
    assert.equal(page.elements.get("dbResults").hidden, false);
    assert.equal(page.elements.get("dbTableContainer").hidden, false);
    assert.equal(page.elements.get("getFromDbBtn").disabled, false);
    assert.match(page.elements.get("dbStatus").textContent, /1 saved order/);
});

test("Get from DB shows empty and failure states and allows retry", async () => {
    let fail = true;
    const page = loadPage({
        ordersFetch: async () => fail
            ? response({ success: false, message: "Database unavailable" }, 500)
            : response({ success: true, data: [] })
    });
    await page.click("getFromDbBtn");
    assert.match(page.elements.get("dbStatus").textContent, /Unable to load saved orders: HTTP 500/);
    assert.equal(page.elements.get("dbTableContainer").hidden, true);
    assert.equal(page.elements.get("getFromDbBtn").disabled, false);
    fail = false;
    await page.click("getFromDbBtn");
    assert.equal(page.elements.get("dbStatus").textContent, "No saved orders found.");
});

test("Get from DB rejects invalid response shapes", async () => {
    const page = loadPage({ ordersFetch: async () => response({ success: true, data: {} }) });
    await page.click("getFromDbBtn");
    assert.match(page.elements.get("dbStatus").textContent, /Invalid orders response/);
    assert.equal(page.elements.get("dbTableContainer").hidden, true);
});

test("Clear DB requires confirmation and only deletes on confirmation", async () => {
    const page = loadPage({ clearFetch: async () => response({ success: true, deletedCount: 1 }) });
    await page.click("clearDbBtn");
    assert.equal(page.elements.get("clearDbDialog").open, true);
    assert.equal(page.requests.length, 0);
    await page.click("confirmClearDbBtn");
    assert.equal(page.elements.get("clearDbDialog").open, false);
    assert.deepEqual(page.requests.map(request => request.url), ["/api/local/orders/clear"]);
    assert.equal(page.requests[0].options.method, "POST");
    assert.match(page.elements.get("dbStatus").textContent, /Database cleared. 1 saved order/);
});

test("Clear DB preserves displayed rows on failure and allows retry", async () => {
    let fail = true;
    const page = loadPage({
        ordersFetch: async () => response({ success: true, data: [{ orderRefId: "MBB1" }] }),
        clearFetch: async () => fail
            ? response({ success: false }, 500)
            : response({ success: true, deletedCount: 1 })
    });
    await page.click("getFromDbBtn");
    await page.click("clearDbBtn");
    await page.click("confirmClearDbBtn");
    assert.match(page.elements.get("dbStatus").textContent, /Unable to clear saved orders: HTTP 500/);
    assert.equal(page.elements.get("dbOrdersBody").children.length, 1);
    assert.equal(page.elements.get("dbTableContainer").hidden, false);
    fail = false;
    await page.click("clearDbBtn");
    await page.click("confirmClearDbBtn");
    assert.equal(page.elements.get("dbOrdersBody").children.length, 0);
});

test("database reads and clears cannot overlap", async () => {
    let resolveOrders;
    let resolveClear;
    const page = loadPage({
        ordersFetch: () => new Promise(resolve => { resolveOrders = resolve; }),
        clearFetch: () => new Promise(resolve => { resolveClear = resolve; })
    });
    const reading = page.click("getFromDbBtn");
    await page.click("clearDbBtn");
    await page.click("confirmClearDbBtn");
    assert.equal(page.requests.length, 1);
    resolveOrders(response({ success: true, data: [] }));
    await reading;
    await page.click("clearDbBtn");
    const clearing = page.click("confirmClearDbBtn");
    await page.click("getFromDbBtn");
    await page.click("clearDbBtn");
    await page.click("confirmClearDbBtn");
    assert.equal(page.requests.length, 2);
    resolveClear(response({ success: true, deletedCount: 0 }));
    await clearing;
    assert.equal(page.elements.get("clearDbBtn").disabled, false);
    assert.equal(page.elements.get("getFromDbBtn").disabled, false);
});
