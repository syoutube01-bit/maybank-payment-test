import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ctosCss from "../../styles/ctos-landing.css?raw";
import { expect, test, vi } from "vitest";
import {
    deferred, pageStyles, renderApp, response, setPlatform, stubBridge, stubFetch, stubLocation, textResponse,
    UUID_V4, validToken
} from "../../test/utils";

const validOrder = {
    statusCode: "0000",
    redirection: { ios: "https://payment/ios", android: "https://payment/android" }
};
const validParty = { Data: { demographics: { partyName: { registeredName: "TEST CUSTOMER" } } } };

async function defaultRoutes(url) {
    if (url === "/api/dp/token") return response(validToken);
    if (url === "/api/dp/view-party") return response(validParty);
    return response(validOrder);
}

// Mounts the CTOS page, waits for its on-load View Party request to finish, then
// switches fetch to the Buy scenario under test.
async function loadCheckout({ platform = "iPhone", fetch, mountFetch = defaultRoutes, bridge } = {}) {
    const windowLocation = stubLocation("?partnerId=mbb-mae-ctos");
    setPlatform(platform);
    const native = stubBridge(bridge ?? (async () => ({ webInitToken: "init-token" })));
    let handler = mountFetch;
    const fetchMock = stubFetch((url, options) => handler(url, options));
    const user = userEvent.setup();
    const view = renderApp("/ctos-landing.html?partnerId=mbb-mae-ctos");
    const byId = id => document.getElementById(id);
    await waitFor(() => expect(byId("viewPartyResponse").textContent).not.toMatch(/^(Loading\.\.\.)?$/));
    const mountRequests = fetchMock.mock.calls.map(([url, options]) => ({ url, options }));
    fetchMock.mockClear();
    handler = fetch ?? defaultRoutes;
    return {
        ...view,
        user,
        byId,
        windowLocation,
        native,
        fetch: fetchMock,
        mountRequests,
        requests: () => fetchMock.mock.calls.map(([url, options]) => ({ url, options })),
        click: () => user.click(byId("buyButton"))
    };
}

test("CTOS edits and saves the displayed amount used by checkout", async () => {
    const checkout = await loadCheckout();
    const { byId, user } = checkout;
    const button = byId("amountButton");
    const input = byId("amountInput");
    const display = byId("amountDisplay");
    await user.click(button);
    expect(button).toHaveTextContent(/^Save$/);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(input).not.toHaveAttribute("hidden");
    expect(input).toHaveValue(100);
    expect(input).toHaveFocus();
    expect(display).toHaveAttribute("hidden");
    expect(byId("buyButton")).toBeDisabled();
    await checkout.click();
    expect(checkout.fetch).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "125.75");
    await user.click(button);
    expect(display).toHaveTextContent(/^RM125\.75$/);
    expect(display).not.toHaveAttribute("hidden");
    expect(input).toHaveAttribute("hidden");
    expect(button).toHaveTextContent(/^Edit$/);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(byId("buyButton")).toBeEnabled();
    await user.click(button);
    expect(input).toHaveValue(125.75);
    await user.clear(input);
    await user.type(input, "0.01");
    await user.click(button);
    await checkout.click();
    await waitFor(() => expect(byId("paymentStatus")).toHaveTextContent("Redirecting to payment..."));
    expect(JSON.parse(checkout.requests()[1].options.body).amount).toBe(0.01);
    expect(display).toHaveTextContent(/^RM0\.01$/);
});

for (const value of ["", "0", "-1", "abc", "Infinity", "1.001"]) {
    test(`CTOS rejects invalid payment amount (${value})`, async () => {
        const checkout = await loadCheckout();
        const { byId, user } = checkout;
        const reportValidity = vi.spyOn(HTMLInputElement.prototype, "reportValidity");
        const button = byId("amountButton");
        const input = byId("amountInput");
        await user.click(button);
        await user.clear(input);
        if (value) await user.type(input, value);
        await user.click(button);
        expect(reportValidity).toHaveBeenCalled();
        expect(input.checkValidity()).toBe(false);
        expect(button).toHaveTextContent(/^Save$/);
        expect(input).not.toHaveAttribute("hidden");
        expect(byId("buyButton")).toBeDisabled();
        await user.clear(input);
        await user.type(input, "150");
        await user.click(button);
        expect(byId("amountDisplay")).toHaveTextContent(/^RM150$/);
        expect(byId("buyButton")).toBeEnabled();
    });
}

test("CTOS hides API test and opens it only on a brand double-click, preserving launch parameters", async () => {
    const checkout = await loadCheckout();
    const apiTestLink = checkout.byId("apiTestLink");
    expect(apiTestLink).toHaveAttribute("hidden");
    expect(apiTestLink).toHaveAttribute("href", "/index.html?partnerId=mbb-mae-ctos");
    expect(pageStyles()).toContain(".api-test[hidden] { display: none; }");
    const brand = checkout.byId("ctosBrand");
    expect(brand.tagName).toBe("DIV");
    expect(brand).toHaveClass("brand");
    expect(brand).toHaveAttribute("aria-label", "CTOS Score");
    expect(checkout.byId("scoreGauge")).toBeNull();
    await checkout.user.click(brand);
    expect(checkout.location()).toBe("/ctos-landing.html?partnerId=mbb-mae-ctos");
    await checkout.user.dblClick(brand);
    expect(checkout.location()).toBe("/index.html?partnerId=mbb-mae-ctos");
    expect(screen.getByRole("heading", { name: "Select Payment Type" })).toBeInTheDocument();
});

test("CTOS landing page requests view party once on load", async () => {
    const checkout = await loadCheckout();

    expect(checkout.mountRequests.map(({ url }) => url)).toEqual(["/api/dp/token", "/api/dp/view-party"]);
    const { options } = checkout.mountRequests[1];
    expect(options.method).toBe("GET");
    expect(options.headers["x-access-token"]).toBe("access-token");
    expect(options.headers["x-webinit-token"]).toBe("init-token");
    const partyResponse = checkout.byId("viewPartyResponse");
    expect(partyResponse.textContent).toBe("The registered party name in the View Party response is TEST CUSTOMER");
    expect([...partyResponse.querySelectorAll("strong")].map(strong => strong.textContent))
        .toEqual(["View Party", "TEST CUSTOMER"]);
    expect(partyResponse.children).toHaveLength(2);
});

for (const [name, partyResponse, expected] of [
    ["HTTP error", () => response({ privateDetail: "not displayed" }, 400), /View Party: HTTP 400/],
    ["invalid JSON", () => textResponse("not JSON"), /Request failed:/],
    ["missing name", () => response({ Data: {} }), /no registered party name/],
    ["null response", () => response(null), /no registered party name/],
    ["blank name", () => response({
        Data: { demographics: { partyName: { registeredName: " " } } }
    }), /no registered party name/]
]) {
    test(`CTOS view party displays an error for ${name}`, async () => {
        const checkout = await loadCheckout({
            mountFetch: async url => url === "/api/dp/token" ? response(validToken) : partyResponse()
        });
        const text = checkout.byId("viewPartyResponse").textContent;
        expect(text).toMatch(expected);
        expect(text).not.toMatch(/not displayed|The register party name is/);
    });
}

for (const [platform, destination] of [["iPhone", "ios"], ["Linux aarch64", "android"]]) {
    test(`Buy fetches a token, creates the displayed order and redirects on ${platform}`, async () => {
        const checkout = await loadCheckout({ platform });

        await checkout.click();
        await waitFor(() => expect(checkout.byId("paymentStatus").textContent).toBe("Redirecting to payment..."));
        for (const call of checkout.native.callAPI.mock.calls) {
            expect(call[0]).toBe("GET_INIT_TOKEN");
            expect(JSON.stringify(call[1])).toBe("{}");
        }
        const requests = checkout.requests();
        expect(requests.map(({ url }) => url)).toEqual(["/api/dp/token", "/api/dp/create-order"]);
        expect(requests[0].options.method).toBe("POST");
        const { options } = requests[1];
        expect(options.method).toBe("POST");
        expect(options.headers["x-access-token"]).toBe("access-token");
        expect(options.headers["x-webinit-token"]).toBe("init-token");
        expect(options.headers["x-partner-id"]).toBe("mbb-mae-ctos");
        expect(options.headers["Content-Type"]).toBe("text/plain");
        expect(options.headers["X-MB-IDEMPOTENCY-KEY"]).toMatch(UUID_V4);
        const body = JSON.parse(options.body);
        expect(body.amount).toBe(100);
        expect(body.currency).toBe("MYR");
        expect(body.partnerReferenceId).toBe("REF20260522");
        expect(body.remark).toBe("CTOS Score Report");
        expect(body.partnerInvoiceId).toMatch(/^INV\d{11}$/);
        expect(checkout.windowLocation.href).toBe(`m2ulife://payment/${destination}`);
    });
}

test("Buy requires agreement and prevents duplicate requests while pending", async () => {
    const token = deferred();
    const checkout = await loadCheckout({
        fetch: url => url === "/api/dp/token" ? token.promise : Promise.resolve(response(validOrder))
    });
    const { byId, user } = checkout;
    const terms = byId("termsAgreement");
    const button = byId("buyButton");
    expect(terms).toBeChecked();
    await user.click(terms);
    expect(button).toBeDisabled();
    await checkout.click();
    expect(checkout.fetch).not.toHaveBeenCalled();
    await user.click(terms);
    expect(button).toBeEnabled();
    await checkout.click();
    expect(button).toBeDisabled();
    expect(byId("amountButton")).toBeDisabled();
    await user.click(terms);
    await user.click(terms);
    expect(button).toBeDisabled();
    await checkout.click();
    expect(checkout.fetch).toHaveBeenCalledTimes(1);
    await user.click(terms);
    token.resolve(response(validToken));
    await waitFor(() => expect(byId("paymentStatus").textContent).toBe("Redirecting to payment..."));
    expect(checkout.fetch).toHaveBeenCalledTimes(2);
    expect(button).toBeDisabled();
    expect(byId("amountButton")).toBeEnabled();
});

for (const scenario of [
    { name: "token HTTP error", token: response("Unavailable", 503), expected: /Get Token: HTTP 503/, calls: 1 },
    { name: "invalid token", token: response({}), expected: /no valid access token/, calls: 1 },
    { name: "blank token", token: response({ ...validToken, responseData: { access_token: " " } }), expected: /no valid access token/, calls: 1 },
    { name: "malformed JSON", token: textResponse("not JSON"), expected: /Payment failed:/, calls: 1 },
    { name: "order HTTP error", order: response("Bad request", 400), expected: /Create Order: HTTP 400/, calls: 2 },
    { name: "order rejection", order: response({ statusCode: "9999" }), expected: /Create Order failed/, calls: 2 },
    { name: "missing redirect", order: response({ statusCode: "0000" }), expected: /No redirection URL/, calls: 2 },
    { name: "network error", error: new Error("Network unavailable"), expected: /Network unavailable/, calls: 1 },
    { name: "native bridge error", bridge: async () => { throw new Error("Bridge unavailable"); }, expected: /Bridge unavailable/, calls: 1 }
]) {
    test(`Buy shows ${scenario.name} without redirecting and allows retry`, async () => {
        let calls = 0;
        const checkout = await loadCheckout({
            bridge: scenario.bridge,
            async fetch() {
                calls++;
                if (scenario.error) throw scenario.error;
                return calls === 1 ? scenario.token ?? response(validToken) : scenario.order;
            }
        });
        await checkout.click();
        await waitFor(() => expect(checkout.byId("paymentStatus").textContent).toMatch(/^Payment failed:/));
        expect(calls).toBe(scenario.calls);
        expect(checkout.byId("paymentStatus").textContent).toMatch(scenario.expected);
        expect(checkout.windowLocation.href).toBe("");
        expect(checkout.byId("buyButton")).toBeEnabled();
    });
}

test("CTOS styles do not visually hide content with the 1px clip pattern", () => {
    expect(ctosCss).not.toMatch(/width:\s*1px;[\s\S]*?clip:\s*rect\(0,\s*0,\s*0,\s*0\)/);
});
