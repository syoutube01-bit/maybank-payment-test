const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const partners = [
    { page: "easybook-landing.html", name: "Easybook", button: "Buy Book" },
    { page: "esim-landing.html", name: "eSIM", button: "Buy eSIM" }
];

function loadPurchase({ page, platform, fetch, bridge }) {
    const elements = new Map();
    for (const id of ["apiTestLink", "buyButton", "paymentStatus", "termsAgreement"]) {
        elements.set(id, {
            href: "/index.html",
            disabled: id === "buyButton",
            checked: true,
            textContent: "",
            listeners: {},
            addEventListener(event, handler) { this.listeners[event] = handler; }
        });
    }
    const window = {
        location: { search: "?partnerId=mbb-mae-test", href: "" },
        nativeMessageService: bridge ?? {
            async callAPI(method, body) {
                assert.equal(method, "GET_INIT_TOKEN");
                assert.deepEqual(JSON.parse(JSON.stringify(body)), {});
                return { webInitToken: "init-token" };
            }
        }
    };
    const html = fs.readFileSync(path.join(__dirname, "../public", page), "utf8");
    assert.match(html, /<script src="\/payment-session\.js"><\/script>\s*<script>/);
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const context = vm.createContext({
        document: { getElementById(id) { return elements.get(id); } },
        navigator: { platform },
        window,
        fetch
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/payment-session.js"), "utf8"), context);
    vm.runInContext(script, context);
    return { elements, window, click: () => elements.get("buyButton").listeners.click() };
}

for (const page of ["ctos-landing.html", "easybook-landing.html", "esim-landing.html"]) {
    test(`${page} repeat purchases reuse the native session token but fetch fresh access tokens`, async () => {
        const requests = [];
        let nativeCalls = 0;
        const checkout = loadPurchase({
            page,
            platform: "iPhone",
            bridge: {
                async callAPI() {
                    nativeCalls++;
                    if (nativeCalls > 1) {
                        throw new Error("Secure token unavailable. Please close and reopen");
                    }
                    return { webInitToken: "session-init-token" };
                }
            },
            async fetch(url, options) {
                requests.push({ url, options });
                return response(url === "/api/dp/token" ? validToken : validOrder);
            }
        });
        await checkout.click();
        await checkout.click();
        assert.equal(nativeCalls, 1);
        assert.deepEqual(requests.map(request => request.url), [
            "/api/dp/token", "/api/dp/create-order", "/api/dp/token", "/api/dp/create-order"
        ]);
        for (const request of requests.filter(request => request.url === "/api/dp/create-order")) {
            assert.equal(request.options.headers["x-webinit-token"], "session-init-token");
        }
        assert.equal(checkout.elements.get("paymentStatus").textContent, "Redirecting to payment...");
        assert.equal(checkout.elements.get("buyButton").disabled, false);
    });

    test(`${page} retries failed native token reads without sending an empty token`, async () => {
        const requests = [];
        let nativeCalls = 0;
        const checkout = loadPurchase({
            page,
            platform: "iPhone",
            bridge: {
                async callAPI() {
                    nativeCalls++;
                    if (nativeCalls === 1) throw new Error("Secure token unavailable");
                    return { webInitToken: "recovered-token" };
                }
            },
            async fetch(url, options) {
                requests.push({ url, options });
                return response(url === "/api/dp/token" ? validToken : validOrder);
            }
        });
        await checkout.click();
        assert.deepEqual(requests.map(request => request.url), ["/api/dp/token"]);
        assert.match(checkout.elements.get("paymentStatus").textContent, /Get Web Init Token: Secure token unavailable/);
        await checkout.click();
        assert.equal(nativeCalls, 2);
        assert.equal(requests.at(-1).options.headers["x-webinit-token"], "recovered-token");
        assert.equal(checkout.elements.get("paymentStatus").textContent, "Redirecting to payment...");
    });

    test(`${page} retains the native token when retrying a failed order`, async () => {
        let nativeCalls = 0;
        let orderCalls = 0;
        const checkout = loadPurchase({
            page,
            platform: "iPhone",
            bridge: {
                async callAPI() {
                    nativeCalls++;
                    if (nativeCalls > 1) throw new Error("Secure token unavailable");
                    return { webInitToken: "session-init-token" };
                }
            },
            async fetch(url, options) {
                if (url === "/api/dp/token") return response(validToken);
                assert.equal(options.headers["x-webinit-token"], "session-init-token");
                orderCalls++;
                return orderCalls === 1 ? response("Unavailable", 503) : response(validOrder);
            }
        });
        await checkout.click();
        assert.match(checkout.elements.get("paymentStatus").textContent, /Create Order: HTTP 503/);
        await checkout.click();
        assert.equal(nativeCalls, 1);
        assert.equal(orderCalls, 2);
        assert.equal(checkout.elements.get("paymentStatus").textContent, "Redirecting to payment...");
    });
}

function response(data, status = 200) {
    return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(data); } };
}

const validToken = { txnStatus: { code: "AOK200" }, responseData: { access_token: "access-token" } };
const validOrder = {
    statusCode: "0000",
    redirection: { ios: "https://payment/ios", android: "https://payment/android" }
};

for (const partner of partners) {
    test(`${partner.name} purchase creates a partner order and redirects to native payment`, async () => {
        const requests = [];
        const checkout = loadPurchase({
            page: partner.page,
            platform: "iPhone",
            async fetch(url, options) {
                requests.push({ url, options });
                return response(requests.length === 1 ? validToken : validOrder);
            }
        });

        assert.equal(checkout.elements.get("buyButton").disabled, false);
        await checkout.click();

        assert.deepEqual(requests.map(({ url }) => url), ["/api/dp/token", "/api/dp/create-order"]);
        const order = JSON.parse(requests[1].options.body);
        assert.equal(order.remark, partner.name);
        assert.equal(order.amount, 100);
        assert.equal(order.currency, "MYR");
        assert.match(order.partnerInvoiceId, /^INV\d{11}$/);
        assert.equal(requests[1].options.headers["x-access-token"], "access-token");
        assert.equal(requests[1].options.headers["x-webinit-token"], "init-token");
        assert.equal(checkout.window.location.href, "m2ulife://payment/ios");
        assert.equal(checkout.elements.get("paymentStatus").textContent, "Redirecting to payment...");
    });
}
