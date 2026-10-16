const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");

function loadCreateOrderRoute(upstreamError) {
    const routes = new Map();
    const requests = [];
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
            return { status: 201, data: { orderId: "test-order-id" } };
        }
    };
    const context = vm.createContext({
        require(name) {
            if (name === "express") return express;
            if (name === "axios") return axios;
            return require(name);
        },
        __dirname: root,
        process,
        URL,
        console: { log() {}, error() {} }
    });
    vm.runInContext(fs.readFileSync(path.join(root, "server.js"), "utf8"), context);
    return { handler: routes.get("/api/create-order"), requests };
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
    const { handler, requests } = loadCreateOrderRoute();
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
});

test("create order rejects missing credentials without calling upstream", async () => {
    for (const field of ["webinitToken", "partnerId"]) {
        const { handler, requests } = loadCreateOrderRoute();
        const response = createResponse();
        await handler({ body: { ...order, [field]: "" } }, response);
        assert.equal(response.statusCode, 400);
        assert.equal(response.body.success, false);
        assert.equal(response.body.message, `${field} is required`);
        assert.equal(requests.length, 0);
    }
});

test("create order preserves upstream errors", async () => {
    const upstreamError = Object.assign(new Error("Request failed"), {
        response: { status: 422, data: { message: "Invalid order" } }
    });
    const { handler } = loadCreateOrderRoute(upstreamError);
    const response = createResponse();
    await handler({ body: { ...order } }, response);
    assert.equal(response.statusCode, 422);
    assert.equal(response.body.success, false);
    assert.equal(response.body.message, "Unable to create payment order");
    assert.deepEqual(response.body.error, upstreamError.response.data);
});
