const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");

function loadCreateOrderRoute(upstreamError, responseData = { orderId: "test-order-id" }) {
    const routes = new Map();
    const requests = [];
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maybank-order-test-"));
    const dbPath = path.join(tempDir, "orders.sqlite");
    const app = {
        use() {},
        get() {},
        post(route, ...handlers) { routes.set(route, handlers.at(-1)); },
        listen() {}
    };
    const express = Object.assign(() => app, {
        json() {}, urlencoded() {}, static() {}, text() {}
    });
    const axios = {
        async post(url, body, config) {
            requests.push({ url, body, config });
            new URL(url);
            if (upstreamError) throw upstreamError;
            return { status: 201, data: responseData };
        }
    };
    const context = vm.createContext({
        require(name) {
            if (name === "express") return express;
            if (name === "axios") return axios;
            return require(name);
        },
        __dirname: root,
        process: { ...process, env: { ...process.env, LOCAL_DB_PATH: dbPath } },
        URL,
        console: { log() {}, error() {} }
    });
    vm.runInContext(fs.readFileSync(path.join(root, "server.js"), "utf8"), context);
    return {
        handler: routes.get("/api/create-order"),
        requests,
        dbPath,
        cleanup() { fs.rmSync(tempDir, { recursive: true, force: true }); }
    };
}

function createResponse() {
    return {
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

const order = {
    webinitToken: "test-webinit-token",
    partnerId: "mbb-mae-easybook",
    partnerInvoiceId: "MB6134155115",
    partnerReferenceId: "REF20260522",
    currency: "MYR",
    amount: 100,
    remark: "New Payment order"
};

test("create order posts to the cURL endpoint with body and headers in the correct arguments", async () => {
    const { handler, requests, cleanup } = loadCreateOrderRoute();
    const response = createResponse();
    await handler({ body: { ...order } }, response);

    assert.equal(requests.length, 1);
    const { url, body, config } = requests[0];
    assert.equal(url, "https://payments-npas.maybank.com.my/sit/payment-sdk/v1/orders");
    const { webinitToken, partnerId, ...expectedBody } = order;
    assert.deepEqual(JSON.parse(JSON.stringify(body)), expectedBody);
    assert.equal(config.headers["Content-Type"], "application/json");
    assert.equal(config.headers["x-mb-client-id"], partnerId);
    assert.equal(config.headers["dip-authorization"], `bearer ${webinitToken}`);
    assert.equal(config.headers["x-mb-env"], "U");
    assert.match(config.headers["x-mb-timestamp"], /^\d+$/);
    assert.equal(response.statusCode, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.orderId, "test-order-id");
    cleanup();
});

test("create order saves the returned order details in the local database", async () => {
    const orderResponse = {
        orderRefId: "MBB768",
        partnerReferenceId: "REF20260522",
        partnerInvoiceId: "INV06640793156",
        currency: "MYR",
        amount: 100,
        createdAt: "2026-10-23T13:51:55.110459",
        paymentStatus: "PENDING",
        orderStatus: "CREATED",
        partnerCode: null,
        partnerName: null,
        PartnerInvoice: "INV06640793156",
        ParnerRefNumber: "REF20260522",
        statusDescription: null,
        completedDateTime: null,
        PaymentStatusCode: null
    };
    const { handler, dbPath, cleanup } = loadCreateOrderRoute(undefined, orderResponse);
    const response = createResponse();
    await handler({ body: { ...order } }, response);

    const db = new DatabaseSync(dbPath);
    const savedOrder = db.prepare("SELECT * FROM orders WHERE orderRefId = ?").get("MBB768");
    db.close();
    assert.deepEqual({ ...savedOrder }, orderResponse);
    cleanup();
});

test("create order rejects missing credentials without calling upstream", async () => {
    for (const field of ["webinitToken", "partnerId"]) {
        const { handler, requests, cleanup } = loadCreateOrderRoute();
        const response = createResponse();
        await handler({ body: { ...order, [field]: "" } }, response);
        assert.equal(response.statusCode, 400);
        assert.equal(response.body.success, false);
        assert.equal(response.body.message, `${field} is required`);
        assert.equal(requests.length, 0);
        cleanup();
    }
});

test("create order preserves upstream errors", async () => {
    const upstreamError = Object.assign(new Error("Request failed"), {
        response: { status: 422, data: { message: "Invalid order" } }
    });
    const { handler, cleanup } = loadCreateOrderRoute(upstreamError);
    const response = createResponse();
    await handler({ body: { ...order } }, response);
    assert.equal(response.statusCode, 422);
    assert.equal(response.body.success, false);
    assert.equal(response.body.message, "Unable to create payment order");
    assert.deepEqual(response.body.error, upstreamError.response.data);
    cleanup();
});
