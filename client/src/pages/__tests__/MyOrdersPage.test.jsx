import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import MyOrdersPage from "../MyOrdersPage";
import { deferred, pageStyles, renderApp, response as jsonResponse, stubFetch, textResponse, webInitJwt } from "../../test/utils";

const tokenResponse = () => jsonResponse({ txnStatus: { code: "AOK200" }, responseData: { access_token: "access-token" } });

function response(orders, status = 200) {
    return textResponse(JSON.stringify({ success: status === 200, data: orders, message: "Request failed" }), status);
}

function order(id, status = "PENDING") {
    return { orderRefId: id, paymentStatus: status, amount: 100, currency: "MYR", createdAt: "2026-10-23" };
}

// Renders the My Orders screen on its own, so it stays mounted after it navigates to the
// lookup receipt (like the old page with a mocked window.location.assign).
function loadOrders({ bridge, fetch, search = "", app = false }) {
    if (bridge) window.nativeMessageService = bridge;
    const prompt = vi.spyOn(window, "prompt");
    const fetchMock = stubFetch(fetch);
    const user = userEvent.setup();
    const url = "/my-orders.html" + search;
    const view = app ? renderApp(url) : renderApp(url, <MyOrdersPage />);
    const byId = id => document.getElementById(id);
    const ui = {
        ...view,
        user,
        prompt,
        fetch: fetchMock,
        get section() { return byId("myOrders"); },
        get message() { return document.querySelector(".my-orders-message"); },
        get list() { return document.querySelector(".my-orders-list"); },
        get button() { return document.querySelector(".my-orders-refresh"); },
        get lookupByOrderId() { return byId("lookupByOrderId"); },
        get lookupByInvoiceId() { return byId("lookupByInvoiceId"); },
        get lookupDialog() { return byId("lookupDialog"); },
        get lookupLabel() { return byId("lookupLabel"); },
        get lookupValue() { return byId("lookupValue"); },
        get lookupCancel() { return byId("lookupCancel"); },
        get lookupOk() { return within(byId("lookupForm")).getByRole("button", { name: "OK" }); },
        stored: () => window.sessionStorage.getItem("lookupPaymentStatus"),
        refresh: () => user.click(ui.button),
        // Opens a lookup dialog and answers it: null cancels, anything else is submitted.
        async lookup(button, value) {
            await user.click(ui[button]);
            expect(ui.lookupDialog.open).toBe(true);
            if (value == null) {
                await user.click(ui.lookupCancel);
                return;
            }
            await user.clear(ui.lookupValue);
            if (value) await user.type(ui.lookupValue, value);
            await user.click(ui.lookupOk);
            if (!value.trim()) await user.click(ui.lookupCancel);
        },
        async initialized() {
            await waitFor(() => expect(ui.button).toBeEnabled());
            await waitFor(() => expect(ui.message.textContent).not.toBe("Loading your orders..."));
        },
        async settled() {
            await waitFor(() => {
                expect(ui.lookupByOrderId).toBeEnabled();
                expect(ui.button).toBeEnabled();
            });
        }
    };
    return ui;
}

const bridgeWith = token => ({ callAPI: vi.fn(async () => ({ webInitToken: token })) });

test("refresh reuses the existing token and replaces orders with a fresh uncached list", async () => {
    let requests = 0;
    const bridge = bridgeWith("existing-token");
    const ui = loadOrders({
        bridge,
        async fetch(url, options) {
            expect(url).toBe("/api/my/orders");
            expect(options.cache).toBe("no-store");
            expect(options.headers["x-webinit-token"]).toBe("existing-token");
            requests++;
            return response([order("MBB1", requests === 1 ? "PENDING" : "SUCCESS")]);
        }
    });
    await ui.initialized();
    expect(ui.message).toHaveAttribute("hidden");
    await ui.refresh();
    await waitFor(() => expect(ui.list.querySelector(".my-order-status")).toHaveTextContent("SUCCESS"));
    expect(bridge.callAPI).toHaveBeenCalledTimes(1);
    expect(requests).toBe(2);
    const link = ui.list.querySelector("li > a");
    expect(link).toHaveAttribute("href", "/paymentstatus?orderId=MBB1");
    expect(link.children[1]).toHaveTextContent("SUCCESS");
    expect(ui.button).toBeEnabled();
    expect(ui.section).toHaveAttribute("aria-busy", "false");
});

test("refresh obtains a missing token after a bridge failure and shows an empty list", async () => {
    let requests = 0;
    const ui = loadOrders({ async fetch() { requests++; return response([]); } });
    await waitFor(() => expect(ui.message.textContent).toMatch(/Unable to load your orders:.*Native payment bridge unavailable/));
    expect(requests).toBe(0);
    expect(ui.button).toBeEnabled();
    window.nativeMessageService = {
        async callAPI(method) {
            expect(method).toBe("GET_INIT_TOKEN");
            return { webInitToken: "new-token" };
        }
    };
    await ui.refresh();
    await waitFor(() => expect(ui.message.textContent).toBe("You have no orders yet."));
    expect(requests).toBe(1);
    expect(ui.message).not.toHaveAttribute("hidden");
});

test("refresh replaces an expired cached token before fetching orders", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const tokens = [webInitJwt({ did: "user", exp: now / 1000 + 3600 }), webInitJwt({ did: "user", exp: now / 1000 + 7200 })];
    let calls = 0;
    const received = [];
    const ui = loadOrders({
        bridge: { async callAPI() { return { webInitToken: tokens[calls++] }; } },
        async fetch(url, options) {
            received.push(options.headers["x-webinit-token"]);
            return response([]);
        }
    });
    await ui.initialized();
    now += 3600 * 1000;
    await ui.refresh();
    await waitFor(() => expect(received).toHaveLength(2));
    expect(calls).toBe(2);
    expect(received).toEqual(tokens);
});

test("refresh shows loading, prevents overlapping requests and recovers after API errors", async () => {
    const pending = deferred();
    let requests = 0;
    const ui = loadOrders({
        bridge: bridgeWith("token"),
        async fetch() {
            requests++;
            if (requests === 1) return response([order("MBB1")]);
            if (requests === 2) return pending.promise;
            return response([order("MBB2")]);
        }
    });
    await ui.initialized();
    await ui.refresh();
    await waitFor(() => expect(requests).toBe(2));
    expect(ui.button).toBeDisabled();
    expect(ui.section).toHaveAttribute("aria-busy", "true");
    expect(ui.message).not.toHaveAttribute("hidden");
    expect(ui.message.textContent).toBe("Loading your orders...");
    await ui.refresh();
    expect(requests).toBe(2);
    pending.resolve(response(null, 500));
    await waitFor(() => expect(ui.message.textContent).toMatch(/Unable to load your orders: Request failed/));
    expect(ui.button).toBeEnabled();
    expect(ui.section).toHaveAttribute("aria-busy", "false");
    await ui.refresh();
    await waitFor(() => expect(ui.message).toHaveAttribute("hidden"));
    expect(requests).toBe(3);
});

test("Order ID and Invoice ID buttons call their matching lookup APIs and navigate with response values", async () => {
    const ui = loadOrders({
        bridge: bridgeWith("init-token"),
        async fetch(url) {
            if (url === "/api/my/orders") return response([]);
            if (url === "/api/dp/token") return tokenResponse();
            return jsonResponse(order(url.includes("order-by-invoice") ? "MBB2" : "MBB1", "SUCCESS"));
        }
    });
    await ui.initialized();

    await ui.user.click(ui.lookupByOrderId);
    const prompts = [[ui.lookupLabel.textContent, ui.lookupValue.value]];
    await ui.user.clear(ui.lookupValue);
    await ui.user.type(ui.lookupValue, "REF 1");
    await ui.user.click(ui.lookupOk);
    await waitFor(() => expect(ui.navigations).toHaveLength(1));
    expect(JSON.parse(ui.stored())).toEqual(order("MBB1", "SUCCESS"));
    await ui.settled();

    await ui.user.click(ui.lookupByInvoiceId);
    prompts.push([ui.lookupLabel.textContent, ui.lookupValue.value]);
    await ui.user.clear(ui.lookupValue);
    await ui.user.type(ui.lookupValue, "INV 2");
    await ui.user.click(ui.lookupOk);
    await waitFor(() => expect(ui.navigations).toHaveLength(2));
    await ui.settled();

    expect(prompts).toEqual([
        ["Enter Order Reference Id", "MBB393"],
        ["Enter Partner Invoice Id", "INV20260914212"]
    ]);
    const requests = ui.fetch.mock.calls.map(([url, options]) => ({ url, options }));
    expect(requests.map(({ url }) => url)).toEqual([
        "/api/my/orders", "/api/dp/token", "/api/dp/order-status?orderRefId=REF%201",
        "/api/dp/token", "/api/dp/order-by-invoice?partnerInvoiceId=INV%202"
    ]);
    for (const { options } of [requests[2], requests[4]]) {
        expect(options.method).toBe("GET");
        expect(options.headers["x-webinit-token"]).toBe("init-token");
        expect(options.headers["x-access-token"]).toBe("access-token");
    }
    expect(requests[1].options.method).toBe("POST");
    expect(JSON.parse(ui.stored())).toEqual(order("MBB2", "SUCCESS"));
    expect(ui.navigations).toEqual(["/lookup-payment-status.html", "/lookup-payment-status.html"]);
    expect(ui.lookupByOrderId).toBeEnabled();
    expect(ui.lookupByInvoiceId).toBeEnabled();
    expect(ui.prompt).not.toHaveBeenCalled();
});

test("a successful lookup opens the lookup receipt with the response values", async () => {
    const ui = loadOrders({
        app: true,
        bridge: bridgeWith("init-token"),
        async fetch(url) {
            if (url === "/api/my/orders") return response([]);
            if (url === "/api/dp/token") return tokenResponse();
            return jsonResponse({ ...order("MBB5", "SUCCESS"), partnerInvoiceId: "INV5" });
        }
    });
    await ui.initialized();
    await ui.lookup("lookupByInvoiceId", "INV5");
    await waitFor(() => expect(ui.location()).toBe("/lookup-payment-status.html"));
    await waitFor(() => expect(document.getElementById("orderRefId")).toHaveTextContent("MBB5"));
    expect(document.getElementById("partnerInvoiceId")).toHaveTextContent("INV5");
    expect(document.getElementById("paymentStatus")).toHaveClass("status-success");
    expect(ui.fetch).toHaveBeenCalledTimes(3);
});

test("both lookups show a loader through token and response processing and clear it on completion", async () => {
    for (const button of ["lookupByOrderId", "lookupByInvoiceId"]) {
        for (const failure of [null, "token", "lookup", "body"]) {
            const token = deferred();
            const lookup = deferred();
            const body = deferred();
            const tokenStarted = deferred();
            const lookupStarted = deferred();
            const bodyStarted = deferred();
            const ui = loadOrders({
                bridge: bridgeWith("token"),
                async fetch(url) {
                    if (url === "/api/my/orders") return response([]);
                    if (url === "/api/dp/token") {
                        tokenStarted.resolve();
                        return token.promise;
                    }
                    lookupStarted.resolve();
                    return lookup.promise;
                }
            });
            await ui.initialized();
            const assertLoading = () => {
                expect(ui.message).toHaveAttribute("data-loading", "true");
                expect(ui.message).not.toHaveAttribute("hidden");
                expect(ui.message.textContent).toBe("Looking up order...");
                expect(ui.lookupByOrderId).toBeDisabled();
                expect(ui.lookupByInvoiceId).toBeDisabled();
                expect(ui.button).toBeDisabled();
            };
            await ui.lookup(button, "MBB777");
            await act(() => tokenStarted.promise);
            assertLoading();
            await ui.refresh();
            await ui.user.click(ui[button]);
            expect(ui.lookupDialog.open).toBe(false);
            assertLoading();
            await act(async () => {
                token.resolve({
                    ok: failure !== "token", status: failure === "token" ? 500 : 200,
                    async text() {
                        return JSON.stringify({ txnStatus: { code: "AOK200" }, responseData: { access_token: "access" } });
                    }
                });
            });
            if (failure !== "token") {
                await act(() => lookupStarted.promise);
                assertLoading();
                await act(async () => {
                    lookup.resolve({
                        ok: failure !== "lookup", status: failure === "lookup" ? 500 : 200,
                        text() {
                            bodyStarted.resolve();
                            return body.promise;
                        }
                    });
                });
                await act(() => bodyStarted.promise);
                assertLoading();
                await act(async () => {
                    body.resolve(failure === "body" ? "invalid JSON" : JSON.stringify({ order: order("MBB777") }));
                });
            }
            await ui.settled();
            expect(ui.message).not.toHaveAttribute("data-loading");
            expect(ui.lookupByOrderId).toBeEnabled();
            expect(ui.lookupByInvoiceId).toBeEnabled();
            expect(ui.button).toBeEnabled();
            if (failure) {
                expect(ui.message).not.toHaveAttribute("hidden");
                expect(ui.message.textContent).toMatch(/Lookup failed:/);
                expect(ui.navigations).toEqual([]);
            } else {
                expect(ui.message).toHaveAttribute("hidden");
                expect(ui.navigations).toEqual(["/lookup-payment-status.html"]);
            }
            ui.unmount();
        }
    }
});

test("lookup dialog supports labels, defaults, blank validation, Cancel and Escape without native prompts", async () => {
    const ui = loadOrders({
        bridge: bridgeWith("token"),
        async fetch(url) {
            expect(url).toBe("/api/my/orders");
            return response([]);
        }
    });
    await ui.initialized();
    expect(ui.lookupDialog).toHaveAttribute("aria-labelledby", "lookupLabel");
    expect(ui.lookupLabel.tagName).toBe("LABEL");
    expect(ui.lookupLabel).toHaveAttribute("for", "lookupValue");
    for (const [button, label, value] of [
        ["lookupByOrderId", "Enter Order Reference Id", "MBB393"],
        ["lookupByInvoiceId", "Enter Partner Invoice Id", "INV20260914212"]
    ]) {
        for (const cancel of ["button", "escape"]) {
            await ui.user.click(ui[button]);
            expect(ui.lookupDialog.open).toBe(true);
            expect(ui.lookupLabel.textContent).toBe(label);
            expect(ui.lookupValue).toHaveValue(value);
            expect(ui.lookupValue).toHaveFocus();
            await ui.user.click(ui[button]);
            expect(ui.lookupLabel.textContent).toBe(label);
            await ui.user.clear(ui.lookupValue);
            await ui.user.type(ui.lookupValue, "   ");
            await ui.user.click(ui.lookupOk);
            expect(ui.lookupDialog.open).toBe(true);
            expect(ui.message).not.toHaveAttribute("data-loading");
            if (cancel === "button") await ui.user.click(ui.lookupCancel);
            else act(() => ui.lookupDialog.close());
            expect(ui.lookupDialog.open).toBe(false);
            await ui.settled();
            expect(ui.message.textContent).toBe("You have no orders yet.");
        }
    }
    expect(ui.fetch).toHaveBeenCalledTimes(1);
    expect(ui.prompt).not.toHaveBeenCalled();
});

test("cancelled and blank lookup prompts do not show a loader or request a token", async () => {
    const ui = loadOrders({
        bridge: bridgeWith("token"),
        async fetch(url) {
            expect(url).toBe("/api/my/orders");
            return response([]);
        }
    });
    await ui.initialized();
    for (const value of [null, "", "   "]) {
        await ui.lookup("lookupByOrderId", value);
        await ui.lookup("lookupByInvoiceId", value);
        expect(ui.lookupDialog.open).toBe(false);
        expect(ui.message).not.toHaveAttribute("data-loading");
        expect(ui.message.textContent).toBe("You have no orders yet.");
    }
    expect(ui.fetch).toHaveBeenCalledTimes(1);
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
        window.sessionStorage.clear();
        const ui = loadOrders({
            bridge: bridgeWith("token"),
            async fetch(url) {
                if (url === "/api/my/orders") return response([]);
                return url === "/api/dp/token"
                    ? tokenResponse()
                    : jsonResponse({ statusCode: "0000", status: "SUCCESS", message: "Order retrieved successfully", order: data });
            }
        });
        await ui.initialized();
        await ui.lookup(button, button === "lookupByOrderId" ? data.orderRefId : data.partnerInvoiceId);
        await waitFor(() => expect(ui.navigations).toEqual(["/lookup-payment-status.html"]));
        await ui.settled();
        expect(JSON.parse(ui.stored())).toEqual(data);
        expect(ui.lookupByOrderId).toBeEnabled();
        expect(ui.lookupByInvoiceId).toBeEnabled();
        ui.unmount();
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
        window.sessionStorage.clear();
        const ui = loadOrders({
            bridge: bridgeWith("token"),
            async fetch(url) {
                if (url === "/api/my/orders") return response([]);
                return url === "/api/dp/token" ? tokenResponse() : jsonResponse(payload);
            }
        });
        await ui.initialized();
        await ui.lookup("lookupByInvoiceId", "INV3");
        await waitFor(() => expect(ui.navigations).toEqual(["/lookup-payment-status.html"]));
        expect(JSON.parse(ui.stored()).orderId).toBe("MBB3");
        await ui.settled();
        ui.unmount();
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
            bridge: bridgeWith("token"),
            async fetch(url) {
                if (url === "/api/my/orders") return response([]);
                return url === "/api/dp/token" ? tokenResponse() : textResponse(text, status);
            }
        });
        await ui.initialized();
        await ui.lookup("lookupByOrderId", "MBB1");
        await waitFor(() => expect(ui.message.textContent).toMatch(/^Lookup failed:/));
        await ui.settled();
        expect(ui.message.textContent).toMatch(expected);
        expect(ui.message).not.toHaveAttribute("hidden");
        expect(window.sessionStorage).toHaveLength(0);
        expect(ui.navigations).toEqual([]);
        expect(ui.lookupByOrderId).toBeEnabled();
        expect(ui.lookupByInvoiceId).toBeEnabled();
        ui.unmount();
    }
});

test("lookup storage failures are displayed without navigation", async () => {
    const ui = loadOrders({
        bridge: bridgeWith("token"),
        async fetch(url) {
            if (url === "/api/my/orders") return response([]);
            return url === "/api/dp/token" ? tokenResponse() : jsonResponse(order("MBB1"));
        }
    });
    await ui.initialized();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    await ui.lookup("lookupByOrderId", "MBB1");
    await waitFor(() => expect(ui.message.textContent).toMatch(/Lookup failed: Storage unavailable/));
    expect(ui.navigations).toEqual([]);
});

test("dedicated orders screen requests the current user's orders for every partner", async () => {
    for (const [partner, name] of [["ctos", "CTOS"], ["easybook", "Easybook"], ["esim", "eSIM"]]) {
        const search = "?partnerId=mbb-mae-" + partner + "&source=mae";
        const requests = [];
        const ui = loadOrders({
            search,
            app: true,
            bridge: bridgeWith("token"),
            async fetch(url, init) {
                requests.push([url, init.headers["x-webinit-token"], init.cache]);
                return response([order("MBB1"), order("MBB2", "SUCCESS")]);
            }
        });
        await ui.initialized();
        expect(requests).toEqual([["/api/my/orders", "token", "no-store"]]);
        expect(ui.list.querySelectorAll("li")).toHaveLength(2);
        expect(ui.section).not.toHaveAttribute("hidden");
        expect(ui.message).toHaveAttribute("hidden");
        expect(document.getElementById("partnerName").textContent).toBe(name);
        expect(document.title).toBe(name + " | My Orders");
        expect(document.body).toHaveClass("orders-page");
        ui.unmount();
        expect(document.body).not.toHaveClass("orders-page");
    }
});

test("an unknown partner shows the generic My Orders title", async () => {
    const ui = loadOrders({ search: "?partnerId=constructor", bridge: bridgeWith("token"), fetch: async () => response([]) });
    await ui.initialized();
    expect(document.getElementById("partnerName").textContent).toBe("");
    expect(document.title).toBe("My Orders");
});

test("order cards include a reference, status, formatted amount, date and details link", async () => {
    const ui = loadOrders({
        app: true,
        bridge: bridgeWith("token"),
        async fetch() { return response([order("MBB1", "SUCCESS")]); }
    });
    await ui.initialized();
    const card = ui.list.querySelector("li > a");
    expect(card).toHaveClass("my-order");
    expect(card).toHaveAttribute("href", "/paymentstatus?orderId=MBB1");
    expect(card.children[0].textContent).toBe("Order #MBB1");
    expect(card.children[1]).toHaveAttribute("data-status", "SUCCESS");
    expect(card.children[2].textContent).toBe("MYR 100.00");
    expect(card.children[3].textContent).toBe("Placed 2026-10-23");
    expect(card.children[3]).toHaveAttribute("datetime", "2026-10-23");
    expect(card.children[4].textContent).toBe("View order details");

    await ui.user.click(card);
    expect(ui.location()).toBe("/paymentstatus?orderId=MBB1");
    expect(screen.getByRole("heading", { name: "Payment Status" })).toBeInTheDocument();
});

test("dedicated orders screen loads shared card styling", async () => {
    const ui = loadOrders({ bridge: bridgeWith("token"), fetch: async () => response([]) });
    await ui.initialized();
    const css = pageStyles();
    expect(css).toMatch(/\.my-orders \.my-orders-list \{[^}]*display: grid;[^}]*list-style: none;/);
    expect(css).toMatch(/\.my-orders \.my-order \{[^}]*display: grid;[^}]*border-radius: 16px;/);
    expect(css).toMatch(/\.my-orders \[hidden\] \{ display: none; \}/);
});
