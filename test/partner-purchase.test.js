const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const partners = [
    { page: "easybook-landing.html", name: "Easybook", button: "Buy Book" },
    { page: "esim-landing.html", name: "eSIM", button: "Buy eSIM" }
];

function loadPurchase({ page, platform, fetch }) {
    const elements = new Map();
    for (const id of ["apiTestLink", "buyButton", "paymentStatus"]) {
        elements.set(id, {
            href: "/index.html",
            disabled: id === "buyButton",
            textContent: "",
            listeners: {},
            addEventListener(event, handler) { this.listeners[event] = handler; }
        });
    }
    const window = {
        location: { search: "?partnerId=mbb-mae-test", href: "" },
        nativeMessageService: {
            async callAPI(method, body) {
                assert.equal(method, "GET_INIT_TOKEN");
                assert.deepEqual(JSON.parse(JSON.stringify(body)), {});
                return { webInitToken: "init-token" };
            }
        }
    };
    const html = fs.readFileSync(path.join(__dirname, "../public", page), "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    vm.runInNewContext(script, {
        document: { getElementById(id) { return elements.get(id); } },
        navigator: { platform },
        window,
        fetch
    });
    return { elements, window, click: () => elements.get("buyButton").listeners.click() };
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
