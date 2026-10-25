const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "../public");

function element() {
    return {
        children: [], dataset: {}, attributes: {}, listeners: {}, hidden: false,
        textContent: "",
        append(...children) { this.children.push(...children); },
        appendChild(child) { this.append(child); },
        replaceChildren(...children) { this.children = children; },
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(name, handler) { this.listeners[name] = handler; }
    };
}

function loadOrders({ bridge, fetch, Date: clock = Date, search = "", screen = false }) {
    const section = element();
    const message = element();
    const list = element();
    const button = element();
    const lookupByOrderId = element();
    const lookupByInvoiceId = element();
    const backLink = element();
    const partnerName = element();
    const ordersLink = element();
    const lookupDialog = element();
    const lookupForm = element();
    const lookupLabel = element();
    const lookupValue = element();
    const lookupCancel = element();
    lookupValue.select = () => {};
    lookupDialog.close = value => {
        lookupDialog.returnValue = value || "";
        lookupDialog.open = false;
        lookupDialog.onclose();
    };
    lookupDialog.showModal = () => {
        lookupDialog.open = true;
        if (!ui.answerLookup) return;
        const value = ui.answerLookup(lookupLabel.textContent, lookupValue.value);
        if (value == null || !value.trim()) lookupCancel.onclick();
        else {
            lookupValue.value = value;
            lookupForm.onsubmit({ preventDefault() {} });
        }
    };
    ordersLink.dataset.partnerId = new URLSearchParams(search).get("partnerId");
    const elements = {
        ".my-orders-message": message,
        ".my-orders-list": list,
        ".my-orders-refresh": button
    };
    section.querySelector = selector => elements[selector];
    const document = {
        readyState: "loading",
        getElementById: id => ({
            myOrders: section, backLink, partnerName, myOrdersLink: screen ? null : ordersLink,
            lookupByOrderId, lookupByInvoiceId,
            lookupDialog, lookupForm, lookupLabel, lookupValue, lookupCancel
        })[id] || null,
        querySelector: () => button,
        addEventListener(name, handler) { this[name] = handler; },
        createElement: element,
        createDocumentFragment: element
    };
    const stored = new Map();
    const navigations = [];
    const window = {
        nativeMessageService: bridge,
        location: { search, assign(url) { navigations.push(url); } },
        sessionStorage: { setItem(key, value) { stored.set(key, value); } }
    };
    const context = vm.createContext({ window, document, fetch, atob, Date: clock, URLSearchParams });
    for (const file of ["payment-session.js", "my-orders.js"]) {
        if (screen && file === "my-orders.js") {
            const html = fs.readFileSync(path.join(root, "my-orders.html"), "utf8");
            vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
        }
        vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
    }
    const ui = { window, section, message, list, button, lookupByOrderId, lookupByInvoiceId, backLink, partnerName, ordersLink,
        lookupDialog, lookupForm, lookupLabel, lookupValue, lookupCancel,
        answerLookup: () => null,
        stored, navigations,
        initialize: () => document.DOMContentLoaded() };
    return ui;
}

function response(orders, status = 200) {
    return {
        ok: status === 200, status,
        async text() { return JSON.stringify({ success: status === 200, data: orders, message: "Request failed" }); }
    };
}

function order(id, status = "PENDING") {
    return { orderRefId: id, paymentStatus: status, amount: 100, currency: "MYR", createdAt: "2026-10-23" };
}

test("partner landing pages keep the top My Orders link without embedded order sections", () => {
    for (const page of ["ctos-landing.html", "easybook-landing.html", "esim-landing.html"]) {
        const html = fs.readFileSync(path.join(root, page), "utf8");
        assert.match(html, /<a class="api-test" id="myOrdersLink" href="\/my-orders\.html\?partnerId=mbb-mae-[^"]+" data-partner-id="mbb-mae-[^"]+">My orders<\/a>/);
        assert.doesNotMatch(html, /my-orders\.(?:css|js)/i);
        assert.doesNotMatch(html, /id="myOrders"/);
    }
});

test("refresh reuses the existing token and replaces orders with a fresh uncached list", async () => {
    let nativeCalls = 0;
    let requests = 0;
    const ui = loadOrders({
        bridge: { async callAPI() { nativeCalls++; return { webInitToken: "existing-token" }; } },
        async fetch(url, options) {
            assert.equal(url, "/api/my/orders");
            assert.equal(options.cache, "no-store");
            assert.equal(options.headers["x-webinit-token"], "existing-token");
            requests++;
            return response([order("MBB1", requests === 1 ? "PENDING" : "SUCCESS")]);
        }
    });
    await ui.window.paymentSession.getWebInitToken();
    await ui.initialize();
    assert.equal(ui.message.hidden, true);
    await ui.button.listeners.click();
    assert.equal(nativeCalls, 1);
    assert.equal(requests, 2);
    const link = ui.list.children[0].children[0].children[0];
    assert.equal(link.href, "/paymentstatus?orderId=MBB1");
    assert.equal(link.children[1].textContent, "SUCCESS");
    assert.equal(ui.button.disabled, false);
    assert.equal(ui.section.attributes["aria-busy"], "false");
});

test("refresh obtains a missing token after a bridge failure and shows an empty list", async () => {
    let requests = 0;
    const ui = loadOrders({ async fetch() { requests++; return response([]); } });
    await ui.initialize();
    assert.match(ui.message.textContent, /Unable to load your orders:.*Native payment bridge unavailable/);
    assert.equal(requests, 0);
    assert.equal(ui.button.disabled, false);
    ui.window.nativeMessageService = {
        async callAPI(method) {
            assert.equal(method, "GET_INIT_TOKEN");
            return { webInitToken: "new-token" };
        }
    };
    await ui.button.listeners.click();
    assert.equal(requests, 1);
    assert.equal(ui.message.textContent, "You have no orders yet.");
    assert.equal(ui.message.hidden, false);
});

test("refresh replaces an expired cached token before fetching orders", async () => {
    let now = Date.now();
    class Clock extends Date {
        static now() { return now; }
    }
    const token = exp => "header." + Buffer.from(JSON.stringify({ did: "user", exp })).toString("base64url") + ".sig";
    const tokens = [token(now / 1000 + 3600), token(now / 1000 + 7200)];
    let calls = 0;
    const received = [];
    const ui = loadOrders({
        Date: Clock,
        bridge: { async callAPI() { return { webInitToken: tokens[calls++] }; } },
        async fetch(url, options) {
            received.push(options.headers["x-webinit-token"]);
            return response([]);
        }
    });
    await ui.initialize();
    now += 3600 * 1000;
    await ui.button.listeners.click();
    assert.equal(calls, 2);
    assert.deepEqual(received, tokens);
});

test("refresh shows loading, prevents overlapping requests and recovers after API errors", async () => {
    let finish;
    let requests = 0;
    const ui = loadOrders({
        bridge: { async callAPI() { return { webInitToken: "token" }; } },
        async fetch() {
            requests++;
            if (requests === 1) return response([order("MBB1")]);
            if (requests === 2) return new Promise(resolve => { finish = resolve; });
            return response([order("MBB2")]);
        }
    });
    await ui.initialize();
    const pending = ui.button.listeners.click();
    assert.equal(ui.button.disabled, true);
    assert.equal(ui.section.attributes["aria-busy"], "true");
    assert.equal(ui.message.hidden, false);
    assert.equal(ui.message.textContent, "Loading your orders...");
    await ui.window.myOrders.load();
    assert.equal(requests, 2);
    finish(response(null, 500));
    await pending;
    assert.match(ui.message.textContent, /Unable to load your orders: Request failed/);
    assert.equal(ui.button.disabled, false);
    assert.equal(ui.section.attributes["aria-busy"], "false");
    await ui.button.listeners.click();
    assert.equal(requests, 3);
    assert.equal(ui.message.hidden, true);
});

test("Order ID and Invoice ID buttons call their matching lookup APIs and navigate with response values", async () => {
    const requests = [];
    const prompts = [];
    const ui = loadOrders({
        bridge: { async callAPI() { return { webInitToken: "init-token" }; } },
        async fetch(url, options) {
            requests.push({ url, options });
            if (url === "/api/my/orders") return response([]);
            if (url === "/api/dp/token") {
                return { ok: true, status: 200, async text() {
                    return JSON.stringify({ txnStatus: { code: "AOK200" }, responseData: { access_token: "access-token" } });
                } };
            }
            const data = order(url.includes("order-by-invoice") ? "MBB2" : "MBB1", "SUCCESS");
            return { ok: true, status: 200, async text() { return JSON.stringify(data); } };
        }
    });
    ui.answerLookup = (message, defaultValue) => {
        prompts.push([message, defaultValue]);
        return message === "Enter Order Reference Id" ? "REF 1" : "INV 2";
    };
    await ui.initialize();

    await ui.lookupByOrderId.listeners.click();
    assert.deepEqual(JSON.parse(ui.stored.get("lookupPaymentStatus")), order("MBB1", "SUCCESS"));
    await ui.lookupByInvoiceId.listeners.click();

    assert.deepEqual(prompts, [
        ["Enter Order Reference Id", "MBB393"],
        ["Enter Partner Invoice Id", "INV20260914212"]
    ]);
    assert.deepEqual(requests.map(({ url }) => url), [
        "/api/my/orders", "/api/dp/token", "/api/dp/order-status?orderRefId=REF%201",
        "/api/dp/token", "/api/dp/order-by-invoice?partnerInvoiceId=INV%202"
    ]);
    for (const { options } of requests.slice(2).filter((_, index) => index % 2 === 0)) {
        assert.equal(options.method, "GET");
        assert.equal(options.headers["x-webinit-token"], "init-token");
        assert.equal(options.headers["x-access-token"], "access-token");
    }
    assert.deepEqual(JSON.parse(ui.stored.get("lookupPaymentStatus")), order("MBB2", "SUCCESS"));
    assert.deepEqual(ui.navigations, ["/lookup-payment-status.html", "/lookup-payment-status.html"]);
    assert.equal(ui.lookupByOrderId.disabled, false);
    assert.equal(ui.lookupByInvoiceId.disabled, false);
});

test("both lookups show a loader through token and response processing and clear it on completion", async () => {
    for (const button of ["lookupByOrderId", "lookupByInvoiceId"]) {
        for (const failure of [null, "token", "lookup", "body"]) {
            let finishToken;
            let finishLookup;
            let finishBody;
            let tokenStarted;
            let lookupStarted;
            let bodyStarted;
            const tokenReady = new Promise(resolve => { tokenStarted = resolve; });
            const started = new Promise(resolve => { lookupStarted = resolve; });
            const bodyReady = new Promise(resolve => { bodyStarted = resolve; });
            const ui = loadOrders({
                bridge: { async callAPI() { return { webInitToken: "token" }; } },
                async fetch(url) {
                    if (url === "/api/my/orders") return response([]);
                    if (url === "/api/dp/token") {
                        tokenStarted();
                        return new Promise(resolve => { finishToken = resolve; });
                    }
                    lookupStarted();
                    return new Promise(resolve => { finishLookup = resolve; });
                }
            });
            await ui.initialize();
            await ui.window.paymentSession.getWebInitToken();
            ui.answerLookup = () => "MBB777";
            const pending = ui[button].listeners.click();
            const assertLoading = () => {
                assert.equal(ui.message.dataset.loading, "true");
                assert.equal(ui.message.hidden, false);
                assert.equal(ui.message.textContent, "Looking up order...");
                assert.equal(ui.lookupByOrderId.disabled, true);
                assert.equal(ui.lookupByInvoiceId.disabled, true);
                assert.equal(ui.button.disabled, true);
            };
            await tokenReady;
            assertLoading();
            await ui.window.myOrders.load();
            await ui[button].listeners.click();
            assertLoading();
            await tokenReady;
            finishToken({
                ok: failure !== "token", status: failure === "token" ? 500 : 200,
                async text() { return JSON.stringify({
                    txnStatus: { code: "AOK200" }, responseData: { access_token: "access" }
                }); }
            });
            if (failure !== "token") {
                await started;
                assertLoading();
                finishLookup({
                    ok: failure !== "lookup", status: failure === "lookup" ? 500 : 200,
                    text() {
                        bodyStarted();
                        return new Promise(resolve => { finishBody = resolve; });
                    }
                });
                await bodyReady;
                assertLoading();
                finishBody(failure === "body" ? "invalid JSON" : JSON.stringify({ order: order("MBB777") }));
            }
            await pending;
            assert.equal(ui.message.dataset.loading, undefined);
            assert.equal(ui.lookupByOrderId.disabled, false);
            assert.equal(ui.lookupByInvoiceId.disabled, false);
            assert.equal(ui.button.disabled, false);
            assert.equal(ui.message.hidden, failure === null);
            if (failure) {
                assert.match(ui.message.textContent, /Lookup failed:/);
                assert.deepEqual(ui.navigations, []);
            } else {
                assert.deepEqual(ui.navigations, ["/lookup-payment-status.html"]);
            }
        }
    }
});

test("lookup dialog supports labels, defaults, blank validation, Cancel and Escape without native prompts", async () => {
    const ui = loadOrders({
        bridge: { async callAPI() { return { webInitToken: "token" }; } },
        async fetch(url) {
            assert.equal(url, "/api/my/orders");
            return response([]);
        }
    });
    await ui.initialize();
    ui.answerLookup = null;
    for (const [button, label, value] of [
        ["lookupByOrderId", "Enter Order Reference Id", "MBB393"],
        ["lookupByInvoiceId", "Enter Partner Invoice Id", "INV20260914212"]
    ]) {
        for (const cancel of ["button", "escape"]) {
            const pending = ui[button].listeners.click();
            assert.equal(ui.lookupDialog.open, true);
            assert.equal(ui.lookupLabel.textContent, label);
            assert.equal(ui.lookupValue.value, value);
            await ui[button].listeners.click();
            ui.lookupValue.value = "   ";
            ui.lookupForm.onsubmit({ preventDefault() {} });
            assert.equal(ui.lookupDialog.open, true);
            assert.equal(ui.message.dataset.loading, undefined);
            if (cancel === "button") ui.lookupCancel.onclick();
            else ui.lookupDialog.close();
            await pending;
            assert.equal(ui.lookupDialog.open, false);
            assert.equal(ui.message.textContent, "You have no orders yet.");
        }
    }
    const html = fs.readFileSync(path.join(root, "my-orders.html"), "utf8");
    assert.match(html, /<dialog[^>]+aria-labelledby="lookupLabel"/);
    assert.match(html, /<label id="lookupLabel" for="lookupValue">/);
    assert.doesNotMatch(fs.readFileSync(path.join(root, "my-orders.js"), "utf8"), /window\.prompt/);
});

test("cancelled and blank lookup prompts do not show a loader or request a token", async () => {
    const ui = loadOrders({
        bridge: { async callAPI() { return { webInitToken: "token" }; } },
        async fetch(url) {
            assert.equal(url, "/api/my/orders");
            return response([]);
        }
    });
    await ui.initialize();
    for (const value of [null, "", "   "]) {
        ui.answerLookup = () => value;
        await ui.lookupByOrderId.listeners.click();
        await ui.lookupByInvoiceId.listeners.click();
        assert.equal(ui.message.dataset.loading, undefined);
        assert.equal(ui.message.textContent, "You have no orders yet.");
    }
});

test("lookups accept the DP order envelope and preserve all returned order details", async () => {
    const data = {
        statusCode: "0000",
        orderRefId: "MBB777",
        partnerReferenceId: "REF20260522",
        partnerInvoiceId: "INV15486272711",
        currency: "MYR",
        amount: 100,
        createdAt: "2026-10-23T15:45:43.601290",
        paymentStatus: "SUCCESS",
        token: null,
        redirection: null,
        partnerInfo: {
            partnerName: "Ctos",
            partnerImageUrl: "https://example.com/partner.png"
        },
        orderStatus: "SUCCESS"
    };
    for (const button of ["lookupByOrderId", "lookupByInvoiceId"]) {
        const ui = loadOrders({
            bridge: { async callAPI() { return { webInitToken: "token" }; } },
            async fetch(url) {
                if (url === "/api/my/orders") return response([]);
                return { ok: true, status: 200, async text() {
                    return JSON.stringify(url === "/api/dp/token"
                        ? { txnStatus: { code: "AOK200" }, responseData: { access_token: "access" } }
                        : {
                            statusCode: "0000", status: "SUCCESS",
                            message: "Order retrieved successfully", order: data
                        });
                } };
            }
        });
        await ui.initialize();
        ui.answerLookup = () => button === "lookupByOrderId" ? data.orderRefId : data.partnerInvoiceId;
        await ui[button].listeners.click();
        assert.deepEqual(JSON.parse(ui.stored.get("lookupPaymentStatus")), data);
        assert.deepEqual(ui.navigations, ["/lookup-payment-status.html"]);
        assert.equal(ui.lookupByOrderId.disabled, false);
        assert.equal(ui.lookupByInvoiceId.disabled, false);
    }
});

test("lookups accept wrapped responses and existing DP field aliases", async () => {
    const data = {
        orderId: "MBB3", PartnerInvoice: "INV3", ParnerRefNumber: "REF3",
        PaymentStatus: "PENDING", currency: "MYR", amount: "100"
    };
    for (const payload of [
        { txnStatus: { code: "AOK200" }, responseData: data },
        { success: true, data },
        { statusCode: "0000", ...data }
    ]) {
        const ui = loadOrders({
            bridge: { async callAPI() { return { webInitToken: "token" }; } },
            async fetch(url) {
                if (url === "/api/my/orders") return response([]);
                return { ok: true, status: 200, async text() {
                    return JSON.stringify(url === "/api/dp/token"
                        ? { txnStatus: { code: "AOK200" }, responseData: { access_token: "access" } }
                        : payload);
                } };
            }
        });
        await ui.initialize();
        ui.answerLookup = () => "INV3";
        await ui.lookupByInvoiceId.listeners.click();
        assert.equal(JSON.parse(ui.stored.get("lookupPaymentStatus")).orderId, "MBB3");
        assert.deepEqual(ui.navigations, ["/lookup-payment-status.html"]);
    }
});

test("failed, malformed and missing-order lookups stay on My Orders and show errors", async () => {
    for (const [status, text, expected] of [
        [404, "Order not found", /HTTP 404.*\nOrder not found/],
        [200, "not JSON", /Lookup failed:/],
        [200, JSON.stringify({ success: false, message: "Rejected" }), /Rejected/],
        [200, JSON.stringify({ statusCode: "9999", message: "Not found" }), /Not found/],
        [200, JSON.stringify({ statusCode: "9999", message: "Rejected", order: order("MBB1") }), /Rejected/],
        [200, JSON.stringify({ txnStatus: { code: "ERROR", message: "Denied" } }), /Denied/],
        ...[null, [], {}, { orderRefId: " " }, { orderRefId: 123 }].map(data =>
            [200, JSON.stringify({ statusCode: "0000", order: data }), /no valid order details/]),
        ...[null, [], {}, { orderRefId: " " }, { orderRefId: 123 }].map(data =>
            [200, JSON.stringify(data), /no valid order details/])
    ]) {
        const ui = loadOrders({
            bridge: { async callAPI() { return { webInitToken: "token" }; } },
            async fetch(url) {
                if (url === "/api/my/orders") return response([]);
                return { ok: status === 200 || url === "/api/dp/token", status, async text() {
                    return url === "/api/dp/token"
                        ? JSON.stringify({ txnStatus: { code: "AOK200" }, responseData: { access_token: "access" } })
                        : text;
                } };
            }
        });
        await ui.initialize();
        ui.answerLookup = () => "MBB1";
        await ui.lookupByOrderId.listeners.click();
        assert.match(ui.message.textContent, expected);
        assert.equal(ui.message.hidden, false);
        assert.equal(ui.stored.size, 0);
        assert.deepEqual(ui.navigations, []);
        assert.equal(ui.lookupByOrderId.disabled, false);
        assert.equal(ui.lookupByInvoiceId.disabled, false);
    }
});

test("lookup storage failures are displayed without navigation", async () => {
    const ui = loadOrders({
        bridge: { async callAPI() { return { webInitToken: "token" }; } },
        async fetch(url) {
            if (url === "/api/my/orders") return response([]);
            return { ok: true, status: 200, async text() {
                return JSON.stringify(url === "/api/dp/token"
                    ? { txnStatus: { code: "AOK200" }, responseData: { access_token: "access" } }
                    : order("MBB1"));
            } };
        }
    });
    await ui.initialize();
    ui.answerLookup = () => "MBB1";
    ui.window.sessionStorage.setItem = () => { throw new Error("Storage unavailable"); };
    await ui.lookupByOrderId.listeners.click();
    assert.match(ui.message.textContent, /Lookup failed: Storage unavailable/);
    assert.deepEqual(ui.navigations, []);
});

test("partner landing pages link to their own orders while retaining partner identity", () => {
    for (const [page, partnerId] of [["ctos-landing.html", "mbb-mae-ctos"],
        ["easybook-landing.html", "mbb-mae-easybook"], ["esim-landing.html", "mbb-mae-esim"]]) {
        const html = fs.readFileSync(path.join(root, page), "utf8");
        assert.match(html, new RegExp(`"x-partner-id": "${partnerId}"`));
        assert.match(html, new RegExp(`<a class="api-test" id="myOrdersLink" href="/my-orders.html\\?partnerId=${partnerId}" data-partner-id="${partnerId}">My orders</a>`));
        assert.doesNotMatch(html, /id="myOrders"/);
    }
    const screen = fs.readFileSync(path.join(root, "my-orders.html"), "utf8");
    assert.match(screen, /<script src="\/my-orders.js"><\/script>/);
});

test("dedicated orders screen requests the current user's orders for every partner", async () => {
    for (const partner of ["ctos", "easybook", "esim"]) {
        const search = "?partnerId=mbb-mae-" + partner + "&source=mae";
        const requests = [];
        const options = {
            search,
            bridge: { async callAPI() { return { webInitToken: "token" }; } },
            async fetch(url, init) {
                requests.push([url, init.headers["x-webinit-token"], init.cache]);
                return response([order("MBB1"), order("MBB2", "SUCCESS")]);
            }
        };
        const screen = loadOrders({ ...options, screen: true });
        await screen.initialize();
        assert.deepEqual(requests, [
            ["/api/my/orders", "token", "no-store"]
        ]);
        assert.equal(screen.list.children[0].children.length, 2);
        assert.equal(screen.section.hidden, false);
        assert.equal(screen.message.hidden, true);
        assert.equal(screen.backLink.href, "/" + search);
        assert.ok(screen.partnerName.textContent);
    }
});

test("order cards include a reference, status, formatted amount, date and details link", async () => {
    const ui = loadOrders({
        bridge: { async callAPI() { return { webInitToken: "token" }; } },
        async fetch() { return response([order("MBB1", "SUCCESS")]); }
    });
    await ui.initialize();
    const card = ui.list.children[0].children[0].children[0];
    assert.equal(card.className, "my-order");
    assert.equal(card.href, "/paymentstatus?orderId=MBB1");
    assert.equal(card.children[0].textContent, "Order #MBB1");
    assert.equal(card.children[1].dataset.status, "SUCCESS");
    assert.equal(card.children[2].textContent, "MYR 100.00");
    assert.equal(card.children[3].textContent, "Placed 2026-10-23");
    assert.equal(card.children[3].dateTime, "2026-10-23");
    assert.equal(card.children[4].textContent, "View order details");
});

test("dedicated orders screen loads shared card styling without adding it to landing pages", () => {
    const screen = fs.readFileSync(path.join(root, "my-orders.html"), "utf8");
    assert.match(screen, /href="\/my-orders.css"/);
    for (const page of ["ctos-landing.html", "easybook-landing.html", "esim-landing.html"]) {
        assert.doesNotMatch(fs.readFileSync(path.join(root, page), "utf8"), /href="\/my-orders\.css"/);
    }
    const css = fs.readFileSync(path.join(root, "my-orders.css"), "utf8");
    assert.match(css, /\.my-orders \.my-orders-list \{[^}]*display: grid;[^}]*list-style: none;/);
    assert.match(css, /\.my-orders \.my-order \{[^}]*display: grid;[^}]*border-radius: 16px;/);
    assert.match(css, /\.my-orders \[hidden\] \{ display: none; \}/);
});
