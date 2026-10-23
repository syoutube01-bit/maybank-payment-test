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

function loadOrders({ bridge, fetch, Date: clock = Date }) {
    const section = element();
    const message = element();
    const list = element();
    const button = element();
    const elements = {
        ".my-orders-message": message,
        ".my-orders-list": list,
        ".my-orders-refresh": button
    };
    section.querySelector = selector => elements[selector];
    const document = {
        readyState: "loading",
        getElementById: id => id === "myOrders" ? section : null,
        querySelector: () => button,
        addEventListener(name, handler) { this[name] = handler; },
        createElement: element,
        createDocumentFragment: element
    };
    const window = { nativeMessageService: bridge };
    const context = vm.createContext({ window, document, fetch, atob, Date: clock });
    for (const file of ["payment-session.js", "my-orders.js"]) {
        vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
    }
    return { window, section, message, list, button, initialize: () => document.DOMContentLoaded() };
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

test("all partner pages have an accessible refresh icon next to My Orders", () => {
    for (const page of ["ctos-landing.html", "easybook-landing.html", "esim-landing.html"]) {
        const html = fs.readFileSync(path.join(root, page), "utf8");
        assert.match(html, /class="my-orders-header">\s*<h2 id="myOrdersHeading">My Orders<\/h2>\s*<button class="my-orders-refresh" type="button" aria-label="Refresh my orders"/);
        assert.match(html, /<svg[^>]+aria-hidden="true"/);
        assert.match(html, /<script src="\/my-orders.js"><\/script>/);
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
