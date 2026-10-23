const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function loadCheckout({ platform = "iPhone", fetch, bridge } = {}) {
    const elements = new Map();
    for (const id of ["apiTestLink", "termsAgreement", "buyButton", "paymentStatus"]) {
        elements.set(id, {
            href: "/index.html",
            checked: true,
            textContent: "",
            listeners: {},
            addEventListener(event, handler) { this.listeners[event] = handler; }
        });
    }
    const window = {
        location: { search: "?partnerId=mbb-mae-ctos", href: "" },
        nativeMessageService: bridge ?? { async callAPI() { return { webInitToken: "init-token" }; } }
    };
    const html = fs.readFileSync(path.join(__dirname, "../public/ctos-landing.html"), "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    vm.runInNewContext(script, {
        document: { getElementById(id) { return elements.get(id); } },
        navigator: { platform },
        window,
        fetch
    });
    return {
        elements,
        window,
        click: () => elements.get("buyButton").listeners.click()
    };
}

function response(data, status = 200) {
    return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(data); } };
}

const validToken = { txnStatus: { code: "AOK200" }, responseData: { access_token: "access-token" } };
const validOrder = {
    statusCode: "0000",
    redirection: { ios: "https://payment/ios", android: "https://payment/android" }
};

for (const [platform, destination] of [["iPhone", "ios"], ["Linux aarch64", "android"]]) {
    test(`Buy fetches a token, creates the displayed order and redirects on ${platform}`, async () => {
        const requests = [];
        const checkout = loadCheckout({
            platform,
            bridge: {
                async callAPI(method, body) {
                    assert.equal(method, "GET_INIT_TOKEN");
                    assert.equal(JSON.stringify(body), "{}");
                    return { webInitToken: "init-token" };
                }
            },
            async fetch(url, options) {
                requests.push({ url, options });
                return response(requests.length === 1 ? validToken : validOrder);
            }
        });

        await checkout.click();
        assert.deepEqual(requests.map(({ url }) => url), ["/api/dp/token", "/api/dp/create-order"]);
        assert.equal(requests[0].options.method, "POST");
        const { options } = requests[1];
        assert.equal(options.method, "POST");
        assert.equal(options.headers["x-access-token"], "access-token");
        assert.equal(options.headers["x-webinit-token"], "init-token");
        assert.equal(options.headers["Content-Type"], "text/plain");
        const body = JSON.parse(options.body);
        assert.equal(body.amount, 27.90);
        assert.equal(body.currency, "MYR");
        assert.equal(body.partnerReferenceId, "REF20260522");
        assert.equal(body.remark, "CTOS Score Report");
        assert.match(body.partnerInvoiceId, /^INV\d{11}$/);
        assert.equal(checkout.window.location.href, `m2ulife://payment/${destination}`);
        assert.equal(checkout.elements.get("paymentStatus").textContent, "Redirecting to payment...");
    });
}

test("Buy requires agreement and prevents duplicate requests while pending", async () => {
    let resolveToken;
    let calls = 0;
    const checkout = loadCheckout({
        fetch() {
            calls++;
            if (calls === 1) return new Promise(resolve => { resolveToken = resolve; });
            return Promise.resolve(response(validOrder));
        }
    });
    const terms = checkout.elements.get("termsAgreement");
    const button = checkout.elements.get("buyButton");
    terms.checked = false;
    terms.listeners.change();
    assert.equal(button.disabled, true);
    await checkout.click();
    assert.equal(calls, 0);
    terms.checked = true;
    terms.listeners.change();
    assert.equal(button.disabled, false);
    const pending = checkout.click();
    assert.equal(button.disabled, true);
    terms.listeners.change();
    assert.equal(button.disabled, true);
    await checkout.click();
    assert.equal(calls, 1);
    terms.checked = false;
    resolveToken(response(validToken));
    await pending;
    assert.equal(calls, 2);
    assert.equal(button.disabled, true);
});

for (const scenario of [
    { name: "token HTTP error", token: response("Unavailable", 503), expected: /Get Token: HTTP 503/, calls: 1 },
    { name: "invalid token", token: response({}), expected: /no valid access token/, calls: 1 },
    { name: "blank token", token: response({ ...validToken, responseData: { access_token: " " } }), expected: /no valid access token/, calls: 1 },
    { name: "malformed JSON", token: { ok: true, async text() { return "not JSON"; } }, expected: /Payment failed:/, calls: 1 },
    { name: "order HTTP error", order: response("Bad request", 400), expected: /Create Order: HTTP 400/, calls: 2 },
    { name: "order rejection", order: response({ statusCode: "9999" }), expected: /Create Order failed/, calls: 2 },
    { name: "missing redirect", order: response({ statusCode: "0000" }), expected: /No redirection URL/, calls: 2 },
    { name: "network error", error: new Error("Network unavailable"), expected: /Network unavailable/, calls: 1 },
    { name: "native bridge error", bridge: { async callAPI() { throw new Error("Bridge unavailable"); } }, expected: /Bridge unavailable/, calls: 1 }
]) {
    test(`Buy shows ${scenario.name} without redirecting and allows retry`, async () => {
        let calls = 0;
        const checkout = loadCheckout({
            bridge: scenario.bridge,
            async fetch() {
                calls++;
                if (scenario.error) throw scenario.error;
                return calls === 1 ? scenario.token ?? response(validToken) : scenario.order;
            }
        });
        await checkout.click();
        assert.equal(calls, scenario.calls);
        assert.match(checkout.elements.get("paymentStatus").textContent, scenario.expected);
        assert.equal(checkout.window.location.href, "");
        assert.equal(checkout.elements.get("buyButton").disabled, false);
    });
}
