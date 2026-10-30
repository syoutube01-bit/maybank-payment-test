import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
    pageStyles, renderApp, response, setPlatform, stubBridge, stubFetch, stubLocation, UUID_V4, validToken
} from "../../test/utils";

const validOrder = {
    statusCode: "0000",
    redirection: { ios: "https://payment/ios", android: "https://payment/android" }
};

const partners = [
    { page: "easybook-landing.html", partnerId: "mbb-mae-easybook", name: "Easybook", brandId: "easybookBrand", button: "Buy Book" },
    { page: "esim-landing.html", partnerId: "mbb-mae-esim", name: "eSIM", brandId: "esimBrand", button: "Buy Travel eSIM" }
];
const allPages = [
    { page: "ctos-landing.html", partnerId: "mbb-mae-ctos", name: "CTOS" },
    ...partners
];

async function defaultRoutes(url) {
    if (url === "/api/dp/token") return response(validToken);
    if (url === "/api/dp/view-party") return response({ Data: { demographics: { partyName: { registeredName: "TEST" } } } });
    return response(validOrder);
}

function loadPurchase({ page, platform = "iPhone", fetch = defaultRoutes, bridge, search = "?partnerId=mbb-mae-test" }) {
    const windowLocation = stubLocation(search);
    setPlatform(platform);
    const native = stubBridge(bridge ?? (async (method, body) => {
        expect(method).toBe("GET_INIT_TOKEN");
        expect(body).toEqual({});
        return { webInitToken: "init-token" };
    }));
    const fetchMock = stubFetch(fetch);
    const user = userEvent.setup();
    const view = renderApp("/" + page + search);
    const byId = id => document.getElementById(id);
    return {
        ...view,
        user,
        byId,
        windowLocation,
        native,
        fetch: fetchMock,
        requests: () => fetchMock.mock.calls.map(([url, options]) => ({ url, options })),
        click: () => user.click(byId("buyButton"))
    };
}

async function waitForStatus(checkout, status) {
    await waitFor(() => expect(checkout.byId("paymentStatus").textContent).toMatch(status));
    await waitFor(() => expect(checkout.byId("buyButton")).toBeEnabled());
}

for (const { page, brandId } of partners) {
    test(`${page} hides API test and opens it on a wordmark double-click with launch parameters`, async () => {
        const checkout = loadPurchase({ page });
        const apiTestLink = checkout.byId("apiTestLink");
        expect(apiTestLink).toHaveAttribute("hidden");
        expect(apiTestLink).toHaveAttribute("href", "/index.html?partnerId=mbb-mae-test");
        expect(pageStyles()).toContain(".api-test[hidden] { display: none; }");
        const brand = checkout.byId(brandId);
        expect(brand.tagName).toBe("A");
        expect(brand).toHaveClass("wordmark");
        fireEvent.click(brand);
        expect(checkout.location()).toBe("/" + page + "?partnerId=mbb-mae-test");
        const notPrevented = fireEvent.dblClick(brand);
        expect(notPrevented).toBe(false);
        expect(checkout.location()).toBe("/index.html?partnerId=mbb-mae-test");
        expect(screen.getByRole("heading", { name: "Select Payment Type" })).toBeInTheDocument();
    });
}

for (const { page, partnerId, name, button } of partners) {
    test(`${name} purchase creates a partner order and redirects to native payment`, async () => {
        const checkout = loadPurchase({ page });
        expect(screen.getByRole("button", { name: new RegExp(button) })).toBe(checkout.byId("buyButton"));
        expect(checkout.byId("buyButton")).toBeEnabled();
        await checkout.click();
        await waitForStatus(checkout, /^Redirecting to payment\.\.\.$/);

        const requests = checkout.requests();
        expect(requests.map(({ url }) => url)).toEqual(["/api/dp/token", "/api/dp/create-order"]);
        const order = JSON.parse(requests[1].options.body);
        expect(order.remark).toBe(name);
        expect(order.amount).toBe(100);
        expect(order.currency).toBe("MYR");
        expect(order.partnerReferenceId).toBe("REF20260522");
        expect(order.partnerInvoiceId).toMatch(/^INV\d{11}$/);
        expect(requests[1].options.method).toBe("POST");
        expect(requests[1].options.headers["Content-Type"]).toBe("text/plain");
        expect(requests[1].options.headers["x-access-token"]).toBe("access-token");
        expect(requests[1].options.headers["x-webinit-token"]).toBe("init-token");
        expect(requests[1].options.headers["x-partner-id"]).toBe(partnerId);
        expect(checkout.windowLocation.href).toBe("m2ulife://payment/ios");
    });

    test(`${page} repeat purchases reuse the native session token but fetch fresh access tokens`, async () => {
        let nativeCalls = 0;
        const checkout = loadPurchase({
            page,
            bridge: async () => {
                nativeCalls++;
                if (nativeCalls > 1) throw new Error("Secure token unavailable. Please close and reopen");
                return { webInitToken: "session-init-token" };
            }
        });
        await checkout.click();
        await waitForStatus(checkout, /^Redirecting to payment\.\.\.$/);
        await checkout.click();
        await waitFor(() => expect(checkout.fetch).toHaveBeenCalledTimes(4));
        await waitForStatus(checkout, /^Redirecting to payment\.\.\.$/);
        expect(nativeCalls).toBe(1);
        const requests = checkout.requests();
        expect(requests.map(request => request.url)).toEqual([
            "/api/dp/token", "/api/dp/create-order", "/api/dp/token", "/api/dp/create-order"
        ]);
        for (const request of requests.filter(request => request.url === "/api/dp/create-order")) {
            expect(request.options.headers["x-webinit-token"]).toBe("session-init-token");
            expect(request.options.headers["X-MB-IDEMPOTENCY-KEY"]).toMatch(UUID_V4);
        }
        expect(requests[1].options.headers["X-MB-IDEMPOTENCY-KEY"]).not.toBe(requests[3].options.headers["X-MB-IDEMPOTENCY-KEY"]);
        expect(checkout.byId("buyButton")).toBeEnabled();
    });

    test(`${page} retries failed native token reads without sending an empty token`, async () => {
        let nativeCalls = 0;
        const checkout = loadPurchase({
            page,
            bridge: async () => {
                nativeCalls++;
                if (nativeCalls === 1) throw new Error("Secure token unavailable");
                return { webInitToken: "recovered-token" };
            }
        });
        await checkout.click();
        await waitForStatus(checkout, /Get Web Init Token: Secure token unavailable/);
        expect(checkout.requests().map(request => request.url)).toEqual(["/api/dp/token"]);
        await checkout.click();
        await waitForStatus(checkout, /^Redirecting to payment\.\.\.$/);
        expect(nativeCalls).toBe(2);
        expect(checkout.requests().at(-1).options.headers["x-webinit-token"]).toBe("recovered-token");
    });

    test(`${page} retains the native token when retrying a failed order`, async () => {
        let nativeCalls = 0;
        let orderCalls = 0;
        const checkout = loadPurchase({
            page,
            bridge: async () => {
                nativeCalls++;
                if (nativeCalls > 1) throw new Error("Secure token unavailable");
                return { webInitToken: "session-init-token" };
            },
            async fetch(url, options) {
                if (url === "/api/dp/token") return response(validToken);
                expect(options.headers["x-webinit-token"]).toBe("session-init-token");
                orderCalls++;
                return orderCalls === 1 ? response("Unavailable", 503) : response(validOrder);
            }
        });
        await checkout.click();
        await waitForStatus(checkout, /Create Order: HTTP 503/);
        await checkout.click();
        await waitForStatus(checkout, /^Redirecting to payment\.\.\.$/);
        expect(nativeCalls).toBe(1);
        expect(orderCalls).toBe(2);
    });
}

// Ported from test/partner-landing.test.js ("each partner page has a distinct landing and returns to the API test screen").
test("each partner page has a distinct landing and returns to the API test screen", () => {
    for (const { page, name } of allPages) {
        const checkout = loadPurchase({ page, search: "?partnerId=mbb-mae-test&source=checkout" });
        expect(screen.getByRole("heading", { level: 1, name })).toBeInTheDocument();
        const apiTestLink = checkout.byId("apiTestLink");
        expect(apiTestLink).toHaveClass("api-test");
        expect(apiTestLink).toHaveTextContent(/^API test$/);
        expect(apiTestLink).toHaveAttribute("href", "/index.html?partnerId=mbb-mae-test&source=checkout");
        checkout.unmount();
    }
});

test("partner landing pages keep the top My Orders link without embedded order sections or order styles", () => {
    for (const { page, partnerId } of allPages) {
        const checkout = loadPurchase({ page });
        const link = checkout.byId("myOrdersLink");
        expect(link.tagName).toBe("A");
        expect(link).toHaveClass("api-test");
        expect(link).toHaveTextContent(/^My orders$/);
        expect(link).toHaveAttribute("href", "/my-orders.html?partnerId=" + partnerId);
        expect(link).toHaveAttribute("data-partner-id", partnerId);
        expect(checkout.byId("myOrders")).toBeNull();
        expect(pageStyles()).not.toMatch(/\.my-orders/);
        checkout.unmount();
    }
});

test("the My Orders link opens the partner's orders screen", async () => {
    const checkout = loadPurchase({ page: "esim-landing.html" });
    stubFetch(async () => response({ success: true, data: [] }));
    await checkout.user.click(checkout.byId("myOrdersLink"));
    expect(checkout.location()).toBe("/my-orders.html?partnerId=mbb-mae-esim");
    expect(await screen.findByText("You have no orders yet.")).toBeInTheDocument();
});
