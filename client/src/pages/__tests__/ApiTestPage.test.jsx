import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { deferred, renderApp, response, stubFetch } from "../../test/utils";

function loadPage({
    ordersFetch = async () => response({ success: true, data: [] }),
    clearFetch = async () => response({ success: true, deletedCount: 0 }),
    url = "/?source=test"
} = {}) {
    const fetch = stubFetch(async url => {
        if (url === "/api/local/orders") return ordersFetch();
        if (url === "/api/local/orders/clear") return clearFetch();
        throw new Error("Unexpected request: " + url);
    });
    const user = userEvent.setup();
    const view = renderApp(url);
    const byId = id => document.getElementById(id);
    return {
        ...view,
        fetch,
        user,
        byId,
        click: id => user.click(byId(id)),
        urls: () => fetch.mock.calls.map(([url]) => url),
        rows: () => [...byId("dbOrdersBody").querySelectorAll("tr")]
    };
}

test("home page keeps payment navigation and provides database controls", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const page = loadPage();
    expect(screen.getByRole("button", { name: "Get from DB" })).toHaveAttribute("id", "getFromDbBtn");
    expect(page.byId("clearDbBtn")).toHaveTextContent(/^Clear DB$/);
    const dialog = page.byId("clearDbDialog");
    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog).toHaveAttribute("aria-labelledby", "clearDbTitle");
    expect(dialog).toHaveAttribute("aria-describedby", "clearDbWarning");
    await page.click("clearDbBtn");
    expect(confirm).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);

    await page.click("dpBtn");
    expect(page.location()).toBe("/DPLandingScreen.html?source=test");
    expect(screen.getByRole("heading", { name: "DP Landing Screen" })).toBeInTheDocument();
});

test("PNT navigation preserves the launch parameters", async () => {
    const page = loadPage({ url: "/index.html?source=test" });
    await page.click("pntBtn");
    expect(page.location()).toBe("/PNTOrderCreation.html?source=test");
    expect(screen.getByRole("heading", { name: "Payment Order" })).toBeInTheDocument();
});

test("Get from DB renders all columns as text without requesting a token", async () => {
    const order = {
        orderRefId: "<script>alert(1)</script>", partnerReferenceId: "REF1",
        partnerInvoiceId: "INV1", currency: "MYR", amount: 100,
        createdAt: "2026-10-23", paymentStatus: "PENDING", orderStatus: "CREATED",
        partnerCode: "PAT001", partnerName: "PAT001 Demo Partner",
        PartnerInvoice: "INV1", ParnerRefNumber: "REF1",
        statusDescription: "Payment completed successfully",
        completedDateTime: "2026-10-23T07:29:55Z", PaymentStatusCode: "0000", digitalId: "user-a"
    };
    const page = loadPage({ ordersFetch: async () => response({ success: true, data: [order] }) });
    await page.click("getFromDbBtn");
    await waitFor(() => expect(page.byId("dbStatus")).toHaveTextContent(/1 saved order/));
    expect(page.urls()).toEqual(["/api/local/orders"]);
    const cells = [...page.rows()[0].querySelectorAll("td")];
    expect(cells.map(cell => cell.textContent)).toEqual(Object.values(order).map(String));
    expect(page.byId("dbOrdersBody").querySelector("script")).toBeNull();
    expect(page.byId("dbResults")).not.toHaveAttribute("hidden");
    expect(page.byId("dbTableContainer")).not.toHaveAttribute("hidden");
    expect(page.byId("getFromDbBtn")).toBeEnabled();
});

test("Get from DB shows empty and failure states and allows retry", async () => {
    let fail = true;
    const page = loadPage({
        ordersFetch: async () => fail
            ? response({ success: false, message: "Database unavailable" }, 500)
            : response({ success: true, data: [] })
    });
    await page.click("getFromDbBtn");
    await waitFor(() => expect(page.byId("dbStatus")).toHaveTextContent(/Unable to load saved orders: HTTP 500/));
    expect(page.byId("dbTableContainer")).toHaveAttribute("hidden");
    expect(page.byId("getFromDbBtn")).toBeEnabled();
    fail = false;
    await page.click("getFromDbBtn");
    await waitFor(() => expect(page.byId("dbStatus").textContent).toBe("No saved orders found."));
});

test("Get from DB rejects invalid response shapes", async () => {
    const page = loadPage({ ordersFetch: async () => response({ success: true, data: {} }) });
    await page.click("getFromDbBtn");
    await waitFor(() => expect(page.byId("dbStatus")).toHaveTextContent(/Invalid orders response/));
    expect(page.byId("dbTableContainer")).toHaveAttribute("hidden");
});

test("Clear DB requires confirmation and only deletes on confirmation", async () => {
    const page = loadPage({ clearFetch: async () => response({ success: true, deletedCount: 1 }) });
    await page.click("clearDbBtn");
    expect(page.byId("clearDbDialog").open).toBe(true);
    expect(page.fetch).not.toHaveBeenCalled();
    await page.click("confirmClearDbBtn");
    expect(page.byId("clearDbDialog").open).toBe(false);
    await waitFor(() => expect(page.byId("dbStatus")).toHaveTextContent(/Database cleared. 1 saved order/));
    expect(page.urls()).toEqual(["/api/local/orders/clear"]);
    expect(page.fetch.mock.calls[0][1].method).toBe("POST");
});

test("Clear DB preserves displayed rows on failure and allows retry", async () => {
    let fail = true;
    const page = loadPage({
        ordersFetch: async () => response({ success: true, data: [{ orderRefId: "MBB1" }] }),
        clearFetch: async () => fail
            ? response({ success: false }, 500)
            : response({ success: true, deletedCount: 1 })
    });
    await page.click("getFromDbBtn");
    await waitFor(() => expect(page.rows()).toHaveLength(1));
    await page.click("clearDbBtn");
    await page.click("confirmClearDbBtn");
    await waitFor(() => expect(page.byId("dbStatus")).toHaveTextContent(/Unable to clear saved orders: HTTP 500/));
    expect(page.rows()).toHaveLength(1);
    expect(page.byId("dbTableContainer")).not.toHaveAttribute("hidden");
    fail = false;
    await page.click("clearDbBtn");
    await page.click("confirmClearDbBtn");
    await waitFor(() => expect(page.rows()).toHaveLength(0));
});

test("database reads and clears cannot overlap", async () => {
    const orders = deferred();
    const clear = deferred();
    const page = loadPage({ ordersFetch: () => orders.promise, clearFetch: () => clear.promise });
    await page.click("getFromDbBtn");
    expect(page.byId("getFromDbBtn")).toBeDisabled();
    expect(page.byId("clearDbBtn")).toBeDisabled();
    await page.click("clearDbBtn");
    expect(page.byId("clearDbDialog").open).toBe(false);
    await page.click("confirmClearDbBtn");
    expect(page.fetch).toHaveBeenCalledTimes(1);
    orders.resolve(response({ success: true, data: [] }));
    await waitFor(() => expect(page.byId("clearDbBtn")).toBeEnabled());

    await page.click("clearDbBtn");
    await page.click("confirmClearDbBtn");
    expect(page.byId("getFromDbBtn")).toBeDisabled();
    expect(page.byId("clearDbBtn")).toBeDisabled();
    await page.click("getFromDbBtn");
    await page.click("clearDbBtn");
    await page.click("confirmClearDbBtn");
    expect(page.fetch).toHaveBeenCalledTimes(2);
    clear.resolve(response({ success: true, deletedCount: 0 }));
    await waitFor(() => expect(page.byId("clearDbBtn")).toBeEnabled());
    expect(page.byId("getFromDbBtn")).toBeEnabled();
});
