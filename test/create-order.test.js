const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { createPostgresMock } = require("./postgres-test-pool");

const root = path.join(__dirname, "..");

function loadCreateOrderRoute(upstreamError, responseData = { orderId: "test-order-id" }) {
    const routes = new Map();
    const requests = [];
    const postgres = createPostgresMock();
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
            if (name === "pg") return postgres;
            return require(name);
        },
        __dirname: root,
        process: { ...process, env: { ...process.env, DATABASE_URL: "postgres://test" } },
        URL,
        console: { log() {}, error() {} }
    });
    vm.runInContext(fs.readFileSync(path.join(root, "server.js"), "utf8"), context);
    return {
        handler: routes.get("/api/create-order"),
        requests,
        database: postgres.database,
        cleanup() { postgres.database.close(); }
    };
}

function createResponse() {
    return {
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

const order = {
    webinitToken: "header." + Buffer.from(JSON.stringify({ did: "test-user" })).toString("base64url") + ".sig",
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

test("create order saves the returned order details in PostgreSQL", async () => {
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
    const { handler, database, cleanup } = loadCreateOrderRoute(undefined, orderResponse);
    const response = createResponse();
    const webinitToken = "eyJhbGciOiJSUzI1NiJ9." +
        Buffer.from(JSON.stringify({ did: "user-768", digitalID: "wrong-user" })).toString("base64url") + ".sig";
    await handler({ body: { ...order, webinitToken } }, response);

    const savedOrder = database.prepare("SELECT * FROM orders WHERE order_ref_id = ?").get("MBB768");
    assert.deepEqual({ ...savedOrder }, {
        order_ref_id: orderResponse.orderRefId,
        partner_reference_id: orderResponse.partnerReferenceId,
        partner_invoice_id: orderResponse.partnerInvoiceId,
        currency: orderResponse.currency,
        amount: orderResponse.amount,
        created_at: orderResponse.createdAt,
        payment_status: orderResponse.paymentStatus,
        order_status: orderResponse.orderStatus,
        partner_code: orderResponse.partnerCode,
        partner_name: orderResponse.partnerName,
        partner_invoice: orderResponse.PartnerInvoice,
        parner_ref_number: orderResponse.ParnerRefNumber,
        status_description: orderResponse.statusDescription,
        completed_date_time: orderResponse.completedDateTime,
        payment_status_code: orderResponse.PaymentStatusCode,
        digital_id: "user-768",
        partner_id: null
    });
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

test("create order rejects invalid did tokens before calling upstream", async () => {
    for (const token of [
        "not-a-jwt",
        ...[{}, { digitalID: "legacy-user" }, { did: " " }, { did: 123 },
            { did: "user", exp: 1 }].map(claims =>
            "header." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".sig")
    ]) {
        const { handler, requests, cleanup } = loadCreateOrderRoute();
        try {
            const response = createResponse();
            await handler({ body: { ...order, webinitToken: token } }, response);
            assert.equal(response.statusCode, 401);
            assert.equal(response.body.success, false);
            assert.equal(requests.length, 0);
        } finally {
            cleanup();
        }
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
