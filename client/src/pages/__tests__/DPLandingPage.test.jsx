import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { deferred, renderApp, response, setPlatform, stubBridge, stubFetch, stubLocation, textResponse, UUID_V4 } from "../../test/utils";

const actions = [
    ["createOrderBtn", "/api/dp/create-order"],
    ["viewPartyBtn", "/api/dp/view-party"],
    ["getByOrderRefBtn", "/api/dp/order-status?orderRefId=REF%20%2F%2B%3F"],
    ["getByInvoiceBtn", "/api/dp/order-by-invoice?partnerInvoiceId=REF%20%2F%2B%3F"]
];
const tokenData = { txnStatus: { code: "AOK200" }, responseData: { access_token: "cached-token" } };

function loadPage({ tokenFetch = async () => response(tokenData), promptValue = "REF /+?" } = {}) {
    const location = stubLocation();
    setPlatform("iPhone");
    stubBridge(async () => ({ webInitToken: "native-token" }));
    const prompt = vi.spyOn(window, "prompt").mockReturnValue(promptValue);
    const fetch = stubFetch(async url => {
        if (url === "/api/dp/token") return tokenFetch();
        return response({ statusCode: "0000", redirection: { ios: "https://payment.test/order" } });
    });
    const user = userEvent.setup();
    renderApp("/DPLandingScreen.html");
    const output = document.getElementById("response");
    return {
        fetch,
        location,
        output,
        prompt,
        requests: () => fetch.mock.calls.map(([url, options]) => ({ url, options })),
        click: id => user.click(document.getElementById(id)),
        // Fires all clicks in the same tick, like simultaneous taps.
        clickAll: () => act(() => { for (const [id] of actions) fireEvent.click(document.getElementById(id)); })
    };
}

// Lets every pending click handler run to completion.
async function settle() {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
}

test("the landing screen has four API buttons and no local database controls", () => {
    loadPage();
    for (const id of ["getTokenBtn", "getFromDbBtn", "clearDbBtn"]) {
        expect(document.getElementById(id)).toBeNull();
    }
    expect(document.querySelectorAll(".left button")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: /DB|Token/ })).toBeNull();
});

for (const [button, endpoint] of actions) {
    test(`${button} obtains a token first and shares it with all subsequent actions`, async () => {
        const page = loadPage();
        expect(page.fetch).not.toHaveBeenCalled();
        await page.click(button);
        await waitFor(() => expect(page.output.textContent).toMatch(/^HTTP 200\n/));
        expect(page.requests()[0].url).toBe("/api/dp/token");
        expect(page.requests()[0].options.method).toBe("POST");
        expect(page.requests()[1].url).toBe(endpoint);

        for (const [nextButton] of actions) {
            const count = page.fetch.mock.calls.length;
            await page.click(nextButton);
            await waitFor(() => expect(page.fetch).toHaveBeenCalledTimes(count + 1));
            await settle();
        }

        const requests = page.requests();
        expect(requests.filter(request => request.url === "/api/dp/token")).toHaveLength(1);
        expect(requests).toHaveLength(6);
        for (const request of requests.slice(1)) {
            expect(request.options.headers["x-access-token"]).toBe("cached-token");
            expect(request.options.headers["x-webinit-token"]).toBe("native-token");
        }
        const order = requests.find(request => request.url === "/api/dp/create-order");
        expect(JSON.parse(order.options.body).partnerInvoiceId).toMatch(/^INV\d{11}$/);
        expect(page.location.href).toBe("m2ulife://payment.test/order");
        expect(page.output.textContent).toMatch(/^HTTP 200\n/);
    });
}

test("simultaneous clicks wait for a single in-flight token request", async () => {
    const token = deferred();
    const page = loadPage({ tokenFetch: () => token.promise });
    await page.clickAll();
    expect(page.fetch).toHaveBeenCalledTimes(1);
    token.resolve(response(tokenData));
    await waitFor(() => expect(page.fetch).toHaveBeenCalledTimes(5));
    await settle();
    for (const request of page.requests().slice(1)) {
        expect(request.options.headers["x-access-token"]).toBe("cached-token");
    }
});

test("create order sends a fresh UUID v4 idempotency key for each request", async () => {
    const page = loadPage();
    await page.click("createOrderBtn");
    await waitFor(() => expect(page.fetch).toHaveBeenCalledTimes(2));
    await settle();
    await page.click("createOrderBtn");
    await waitFor(() => expect(page.fetch).toHaveBeenCalledTimes(3));
    const keys = page.requests().filter(request => request.url === "/api/dp/create-order")
        .map(request => request.options.headers["X-MB-IDEMPOTENCY-KEY"]);
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(key).toMatch(UUID_V4);
    expect(keys[0]).not.toBe(keys[1]);
});

const failures = [
    ["HTTP failure", () => response({ error: "Unavailable" }, 503), /Get Token: HTTP 503/],
    ["rejected status", () => response({ ...tokenData, txnStatus: { code: "ERROR" } }), /no valid access token/],
    ["missing token", () => response({ txnStatus: { code: "AOK200" } }), /no valid access token/],
    ["blank token", () => response({ ...tokenData, responseData: { access_token: " " } }), /no valid access token/],
    ["invalid JSON", () => textResponse("not JSON"), /Request failed:/],
    ["null JSON", () => response(null), /no valid access token/],
    ["network failure", () => Promise.reject(new Error("Network unavailable")), /Network unavailable/]
];

for (const [name, failedResponse, message] of failures) {
    test(`${name} prevents downstream requests, displays the error, and allows retry`, async () => {
        let attempts = 0;
        const page = loadPage({
            tokenFetch: () => ++attempts === 1 ? failedResponse() : response(tokenData)
        });
        await page.clickAll();
        await waitFor(() => expect(page.output.textContent).toMatch(message));
        await settle();
        expect(page.fetch).toHaveBeenCalledTimes(1);
        expect(page.output.textContent).toMatch(message);

        await page.click("viewPartyBtn");
        await waitFor(() => expect(page.fetch).toHaveBeenCalledTimes(3));
        expect(attempts).toBe(2);
        expect(page.requests()[2].options.headers["x-access-token"]).toBe("cached-token");
    });
}

test("cancelled lookups do not request a token or an order", async () => {
    const page = loadPage({ promptValue: null });
    await page.click("getByOrderRefBtn");
    await page.click("getByInvoiceBtn");
    await settle();
    expect(page.prompt).toHaveBeenCalledWith("Enter Order Reference Id", "MBB393");
    expect(page.prompt).toHaveBeenCalledWith("Enter Partner Invoice Id", "INV20260914212");
    expect(page.fetch).not.toHaveBeenCalled();
});

// Ported from test/invoice-lookup.test.js ("the page sends an encoded partnerInvoiceId").
test("the page sends an encoded partnerInvoiceId", async () => {
    const page = loadPage({ promptValue: "INV /+?" });
    await page.click("getByInvoiceBtn");
    await waitFor(() => expect(page.fetch).toHaveBeenCalledTimes(2));
    expect(page.requests()[1].url).toBe("/api/dp/order-by-invoice?partnerInvoiceId=INV%20%2F%2B%3F");
});
