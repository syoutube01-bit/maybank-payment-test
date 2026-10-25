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
            lookupByOrderId, lookupByInvoiceId
        })[id] || null,
        querySelector: () => button,
        addEventListener(name, handler) { this[name] = handler; },
        createElement: element,
        createDocumentFragment: element
    };
    const window = { nativeMessageService: bridge, location: { search }, prompt: () => "" };
    const context = vm.createContext({ window, document, fetch, atob, Date: clock, URLSearchParams });
    for (const file of ["payment-session.js", "my-orders.js"]) {
        if (screen && file === "my-orders.js") {
            const html = fs.readFileSync(path.join(root, "my-orders.html"), "utf8");
            vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
        }
        vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
    }
    return { window, section, message, list, button, lookupByOrderId, lookupByInvoiceId, backLink, partnerName, ordersLink,
        initialize: () => document.DOMContentLoaded() };
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

test("Order ID and Invoice ID buttons call their matching lookup APIs", async () => {
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
            return { ok: true, status: 200, async text() { return JSON.stringify({ status: "SUCCESS" }); } };
        }
    });
    ui.window.prompt = (message, defaultValue) => {
        prompts.push([message, defaultValue]);
        return message === "Enter Order Reference Id" ? "REF 1" : "INV 2";
    };
    await ui.initialize();

    await ui.lookupByOrderId.listeners.click();
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
    assert.equal(ui.message.textContent, 'HTTP 200\n{"status":"SUCCESS"}');
});

test("partner pages have a My orders button next to API test linking to their own order screen", () => {
    for (const [page, partnerId] of [["ctos-landing.html", "mbb-mae-ctos"],
        ["easybook-landing.html", "mbb-mae-easybook"], ["esim-landing.html", "mbb-mae-esim"]]) {
        const html = fs.readFileSync(path.join(root, page), "utf8");
        assert.match(html, new RegExp(`<div class="header-actions">\\s*<a class="api-test" id="myOrdersLink" href="/my-orders.html\\?partnerId=${partnerId}" data-partner-id="${partnerId}">My orders</a>\\s*<a class="api-test" id="apiTestLink"`));
        assert.match(html, new RegExp(`"x-partner-id": "${partnerId}"`));
        assert.match(html, /id="myOrders"/);
    }
    const screen = fs.readFileSync(path.join(root, "my-orders.html"), "utf8");
    assert.match(screen, /<script src="\/my-orders.js"><\/script>/);
});

test("landing and dedicated screens request the same user's orders for every partner", async () => {
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
        const landing = loadOrders(options);
        await landing.initialize();
        assert.equal(landing.ordersLink.href, "/my-orders.html" + search);
        const screen = loadOrders({ ...options, screen: true });
        await screen.initialize();
        assert.deepEqual(requests, [
            ["/api/my/orders", "token", "no-store"],
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

test("every orders view loads shared card styling without a dedicated-page scope", () => {
    for (const page of ["ctos-landing.html", "easybook-landing.html", "esim-landing.html", "my-orders.html"]) {
        assert.match(fs.readFileSync(path.join(root, page), "utf8"), /href="\/my-orders.css"/);
    }
    const css = fs.readFileSync(path.join(root, "my-orders.css"), "utf8");
    assert.match(css, /\.my-orders \.my-orders-list \{[^}]*display: grid;[^}]*list-style: none;/);
    assert.match(css, /\.my-orders \.my-order \{[^}]*display: grid;[^}]*border-radius: 16px;/);
    assert.match(css, /\.my-orders \[hidden\] \{ display: none; \}/);
});
