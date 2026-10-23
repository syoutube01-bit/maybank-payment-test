const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "DPLandingScreen.html"), "utf8");
const actions = [
    ["createOrderBtn", "/api/dp/create-order"],
    ["viewPartyBtn", "/api/dp/view-party"],
    ["getByOrderRefBtn", "/api/dp/order-status?orderRefId=REF%20%2F%2B%3F"],
    ["getByInvoiceBtn", "/api/dp/order-by-invoice?partnerInvoiceId=REF%20%2F%2B%3F"]
];
const tokenData = { txnStatus: { code: "AOK200" }, responseData: { access_token: "cached-token" } };

function response(data, status = 200) {
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data) };
}

function loadPage({
    tokenFetch = async () => response(tokenData),
    promptValue = "REF /+?",
    ordersFetch = async () => response({ success: true, data: [] })
} = {}) {
    const requests = [];
    const listeners = new Map();
    const output = { textContent: "" };
    const elements = new Map();
    function createElement() {
        return {
            textContent: "", hidden: true, children: [],
            appendChild(child) { this.children.push(child); },
            replaceChildren() { this.children = []; },
            addEventListener() {}
        };
    }
    const window = {
        location: { href: "" },
        nativeMessageService: { callAPI: async () => ({ webInitToken: "native-token" }) }
    };
    const context = vm.createContext({
        document: {
            getElementById(id) {
                if (id === "response") return output;
                if (id.startsWith("db")) {
                    if (!elements.has(id)) elements.set(id, createElement());
                    return elements.get(id);
                }
                if (id === "getFromDbBtn") {
                    if (!elements.has(id)) elements.set(id, {
                        disabled: false,
                        addEventListener: (event, handler) => listeners.set(id, handler)
                    });
                    return elements.get(id);
                }
                assert.ok(actions.some(([button]) => button === id));
                return { addEventListener: (event, handler) => listeners.set(id, handler) };
            },
            createElement,
            createDocumentFragment: createElement
        },
        window,
        navigator: { platform: "iPhone" },
        prompt: () => promptValue,
        async fetch(url, options) {
            requests.push({ url, options });
            if (url === "/api/dp/token") return tokenFetch();
            if (url === "/api/local/orders") return ordersFetch();
            return response({ statusCode: "0000", redirection: { ios: "https://payment.test/order" } });
        }
    });
    vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
    return { click: id => listeners.get(id)(), requests, output, window, elements };
}

test("the landing screen has four API buttons and a local database button", () => {
    assert.doesNotMatch(html, /getTokenBtn/);
    assert.equal((html.match(/<button\b/g) || []).length, 5);
});

for (const [button, endpoint] of actions) {
    test(`${button} obtains a token first and shares it with all subsequent actions`, async () => {
        const page = loadPage();
        assert.equal(page.requests.length, 0);
        await page.click(button);
        assert.equal(page.requests[0].url, "/api/dp/token");
        assert.equal(page.requests[0].options.method, "POST");
        assert.equal(page.requests[1].url, endpoint);

        for (const [nextButton] of actions) await page.click(nextButton);

        assert.equal(page.requests.filter(request => request.url === "/api/dp/token").length, 1);
        assert.equal(page.requests.length, 6);
        for (const request of page.requests.slice(1)) {
            assert.equal(request.options.headers["x-access-token"], "cached-token");
            assert.equal(request.options.headers["x-webinit-token"], "native-token");
        }
        const order = page.requests.find(request => request.url === "/api/dp/create-order");
        assert.match(JSON.parse(order.options.body).partnerInvoiceId, /^INV\d{11}$/);
        assert.equal(page.window.location.href, "m2ulife://payment.test/order");
        assert.match(page.output.textContent, /^HTTP 200\n/);
    });
}

test("simultaneous clicks wait for a single in-flight token request", async () => {
    let resolveToken;
    const page = loadPage({
        tokenFetch: () => new Promise(resolve => { resolveToken = resolve; })
    });
    const pending = actions.map(([button]) => page.click(button));
    assert.equal(page.requests.length, 1);
    resolveToken(response(tokenData));
    await Promise.all(pending);
    assert.equal(page.requests.length, 5);
    for (const request of page.requests.slice(1)) {
        assert.equal(request.options.headers["x-access-token"], "cached-token");
    }
});

const failures = [
    ["HTTP failure", () => response({ error: "Unavailable" }, 503), /Get Token: HTTP 503/],
    ["rejected status", () => response({ ...tokenData, txnStatus: { code: "ERROR" } }), /no valid access token/],
    ["missing token", () => response({ txnStatus: { code: "AOK200" } }), /no valid access token/],
    ["blank token", () => response({ ...tokenData, responseData: { access_token: " " } }), /no valid access token/],
    ["invalid JSON", () => ({ ok: true, text: async () => "not JSON" }), /Request failed:/],
    ["null JSON", () => response(null), /no valid access token/],
    ["network failure", () => Promise.reject(new Error("Network unavailable")), /Network unavailable/]
];

for (const [name, failedResponse, message] of failures) {
    test(`${name} prevents downstream requests, displays the error, and allows retry`, async () => {
        let attempts = 0;
        const page = loadPage({
            tokenFetch: () => ++attempts === 1 ? failedResponse() : response(tokenData)
        });
        await Promise.all(actions.map(([button]) => page.click(button)));
        assert.equal(page.requests.length, 1);
        assert.match(page.output.textContent, message);

        await page.click("viewPartyBtn");
        assert.equal(attempts, 2);
        assert.equal(page.requests.length, 3);
        assert.equal(page.requests[2].options.headers["x-access-token"], "cached-token");
    });
}

test("cancelled lookups do not request a token or an order", async () => {
    const page = loadPage({ promptValue: null });
    await page.click("getByOrderRefBtn");
    await page.click("getByInvoiceBtn");
    assert.equal(page.requests.length, 0);
});

test("Get from DB renders all columns as text without requesting a token", async () => {
    const order = {
        orderRefId: "<script>alert(1)</script>", partnerReferenceId: "REF1",
        partnerInvoiceId: "INV1", currency: "MYR", amount: 100,
        createdAt: "2026-10-23", paymentStatus: "PENDING", orderStatus: "CREATED"
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
    await page.click("getFromDbBtn");
    assert.equal(page.elements.get("dbOrdersBody").children.length, 1);
});

test("Get from DB shows an empty state", async () => {
    const page = loadPage();
    await page.click("getFromDbBtn");
    assert.equal(page.elements.get("dbStatus").textContent, "No saved orders found.");
    assert.equal(page.elements.get("dbTableContainer").hidden, true);
});

test("Get from DB shows failures and allows retry", async () => {
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
