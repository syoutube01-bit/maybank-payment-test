const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function loadOrdersRoute(t) {
    const routes = new Map();
    const errors = [];
    const app = {
        use() {}, listen() {},
        post(route, ...handlers) { routes.set("POST " + route, handlers.at(-1)); },
        get(route, ...handlers) { routes.set(route, handlers.at(-1)); }
    };
    const express = Object.assign(() => app, {
        json() {}, urlencoded() {}, static() {}, text() {}
    });
    const root = path.join(__dirname, "..");
    const context = vm.createContext({
        require: name => name === "express" ? express : require(name),
        __dirname: root,
        process: { ...process, env: { ...process.env, LOCAL_DB_PATH: ":memory:" } },
        console: { log() {}, error: (...args) => errors.push(args) }
    });
    vm.runInContext(fs.readFileSync(path.join(root, "server.js"), "utf8"), context);
    const database = vm.runInContext("getOrderDatabase()", context);
    t.after(() => database.close());
    const response = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; }
    };
    return {
        handler: routes.get("/api/local/orders"),
        orderHandler: routes.get("/api/local/orders/:orderRefId"),
        clearHandler: routes.get("POST /api/local/orders/clear"),
        updatePaymentStatusHandler: routes.get("POST /api/local/orders/payment-status"),
        database, response, errors
    };
}

test("local orders returns an empty list from a new database", t => {
    const { handler, response } = loadOrdersRoute(t);
    handler({}, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { success: true, data: [] });
});

test("order lookup returns saved details only for the exact reference", t => {
    const { orderHandler, database, response } = loadOrdersRoute(t);
    database.prepare(`INSERT INTO orders (
        orderRefId, partnerReferenceId, partnerInvoiceId, currency, amount,
        createdAt, paymentStatus, orderStatus
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("MBB777", "REF777", "INV15486272711", "MYR", 100, "2026-10-23", "PENDING", "CREATED");
    orderHandler({ params: { orderRefId: "MBB777" } }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
        success: true,
        data: {
            orderRefId: "MBB777", partnerReferenceId: "REF777", partnerInvoiceId: "INV15486272711",
            currency: "MYR", amount: 100, createdAt: "2026-10-23",
            paymentStatus: "PENDING", orderStatus: "CREATED", partnerCode: null,
            partnerName: null, PartnerInvoice: null, ParnerRefNumber: null,
            statusDescription: null, completedDateTime: null, PaymentStatusCode: null
        }
    });
    for (const orderRefId of ["missing", "MBB777' OR 1=1 --"]) {
        orderHandler({ params: { orderRefId } }, response);
        assert.equal(response.statusCode, 404);
        assert.deepEqual(response.body, { success: false, message: "Order not found" });
    }
});

test("order lookup logs database failures and returns JSON errors", t => {
    const { orderHandler, database, response, errors } = loadOrdersRoute(t);
    database.exec("DROP TABLE orders");
    orderHandler({ params: { orderRefId: "MBB777" } }, response);
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, {
        success: false, message: "Unable to load order from the local database"
    });
    assert.equal(errors.length, 1);
});

test("local orders returns saved orders newest first with deterministic ties", t => {
    const { handler, database, response } = loadOrdersRoute(t);
    const orders = [
        ["MBB1", "REF1", "INV1", "MYR", 100, "2026-10-22", "PENDING", "CREATED"],
        ["MBB2", "REF2", "INV2", "MYR", 200, "2026-10-23", "PAID", "COMPLETED"],
        ["MBB3", "REF3", "INV3", "MYR", 300, "2026-10-23", "PENDING", "CREATED"]
    ];
    const insert = database.prepare(`INSERT INTO orders (
        orderRefId, partnerReferenceId, partnerInvoiceId, currency, amount,
        createdAt, paymentStatus, orderStatus
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const order of orders) insert.run(...order);
    handler({}, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.deepEqual(response.body.data.map(order => Object.values(order).slice(0, 8)), orders.toReversed());
});

test("local orders logs database errors and returns an explicit failure", t => {
    const { handler, database, response, errors } = loadOrdersRoute(t);
    database.exec("DROP TABLE orders");
    handler({}, response);
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, {
        success: false, message: "Unable to load orders from the local database"
    });

    assert.equal(errors.length, 1);
});

test("clear local orders deletes every order and preserves the table for future orders", t => {
    const { handler, clearHandler, database, response } = loadOrdersRoute(t);
    const insert = database.prepare(`INSERT INTO orders (
        orderRefId, partnerReferenceId, partnerInvoiceId, currency, amount,
        createdAt, paymentStatus, orderStatus
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const id of ["MBB1", "MBB2"]) {
        insert.run(id, "REF1", "INV1", "MYR", 100, "2026-10-23", "PENDING", "CREATED");
    }
    clearHandler({}, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { success: true, deletedCount: 2 });
    handler({}, response);
    assert.deepEqual(response.body, { success: true, data: [] });
    clearHandler({}, response);
    assert.deepEqual(response.body, { success: true, deletedCount: 0 });
    insert.run("MBB3", "REF1", "INV1", "MYR", 100, "2026-10-23", "PENDING", "CREATED");
    handler({}, response);
    assert.equal(response.body.data.length, 1);
});

test("clear local orders logs database failures without claiming success", t => {
    const { clearHandler, database, response, errors } = loadOrdersRoute(t);
    database.exec("DROP TABLE orders");
    clearHandler({}, response);
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, {
        success: false, message: "Unable to clear orders from the local database"
    });
    assert.equal(errors.length, 1);
});

test("update payment status changes only the matching order's paymentStatus and is idempotent", t => {
    const { updatePaymentStatusHandler, database, response } = loadOrdersRoute(t);
    const insert = database.prepare(`INSERT INTO orders (
        orderRefId, partnerReferenceId, partnerInvoiceId, currency, amount,
        createdAt, paymentStatus, orderStatus
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const id of ["MBB768", "MBB769"]) {
        insert.run(id, "REF1", "INV1", "MYR", 100, "2026-10-23", "PENDING", "CREATED");
    }
    const before = database.prepare("SELECT * FROM orders ORDER BY orderRefId").all();
    const body = { orderRefId: "MBB768", paymentStatus: "SUCCESS" };

    for (let attempt = 0; attempt < 2; attempt++) {
        updatePaymentStatusHandler({ body }, response);
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.body, { success: true, data: body });
        assert.deepEqual(
            database.prepare("SELECT * FROM orders ORDER BY orderRefId").all().map(row => ({ ...row })),
            [{ ...before[0], paymentStatus: "SUCCESS" }, { ...before[1] }]
        );
    }
});

test("update payment status returns 404 for unknown orders and treats IDs as literal values", t => {
    const { updatePaymentStatusHandler, database, response } = loadOrdersRoute(t);
    database.prepare(`INSERT INTO orders (
        orderRefId, partnerReferenceId, partnerInvoiceId, currency, amount,
        createdAt, paymentStatus, orderStatus
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("MBB768", "REF1", "INV1", "MYR", 100, "2026-10-23", "PENDING", "CREATED");
    for (const orderRefId of ["unknown", "MBB768' OR 1=1 --"]) {
        updatePaymentStatusHandler({ body: { orderRefId, paymentStatus: "SUCCESS" } }, response);
        assert.equal(response.statusCode, 404);
        assert.deepEqual(response.body, { success: false, message: "Order not found" });
    }
    assert.equal(database.prepare("SELECT paymentStatus FROM orders").get().paymentStatus, "PENDING");
});

test("update payment status rejects missing, blank, and non-string fields without changing orders", t => {
    const { updatePaymentStatusHandler, database, response } = loadOrdersRoute(t);
    database.prepare(`INSERT INTO orders (
        orderRefId, partnerReferenceId, partnerInvoiceId, currency, amount,
        createdAt, paymentStatus, orderStatus
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("MBB768", "REF1", "INV1", "MYR", 100, "2026-10-23", "PENDING", "CREATED");
    for (const field of ["orderRefId", "paymentStatus"]) {
        for (const value of [undefined, null, "", "   ", 123, [], {}]) {
            const body = { orderRefId: "MBB768", paymentStatus: "SUCCESS", [field]: value };
            updatePaymentStatusHandler({ body }, response);
            assert.equal(response.statusCode, 400);
            assert.deepEqual(response.body, {
                success: false, message: `${field} must be a non-empty string`
            });
        }
    }
    for (const body of [undefined, null, [], "invalid"]) {
        updatePaymentStatusHandler({ body }, response);
        assert.equal(response.statusCode, 400);
    }
    assert.equal(database.prepare("SELECT paymentStatus FROM orders").get().paymentStatus, "PENDING");
});

test("update payment status logs database failures without claiming success", t => {
    const { updatePaymentStatusHandler, database, response, errors } = loadOrdersRoute(t);
    database.exec("DROP TABLE orders");
    updatePaymentStatusHandler({ body: { orderRefId: "MBB768", paymentStatus: "SUCCESS" } }, response);
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, {
        success: false, message: "Unable to update payment status in the local database"
    });
    assert.equal(errors.length, 1);
});

test("payment status updates persist all supplied partner and completion fields", t => {
    const { updatePaymentStatusHandler, database, response } = loadOrdersRoute(t);
    database.prepare(`INSERT INTO orders (
        orderRefId, partnerReferenceId, partnerInvoiceId, currency, amount,
        createdAt, paymentStatus, orderStatus
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("ORD202607170001", "PRN202607170001", "INV202607170001", "MYR",
            100, "2026-07-17T07:29:55Z", "PENDING", "CREATED");

    updatePaymentStatusHandler({
        body: {
            partnerCode: "PAT001",
            partnerName: "PAT001 Demo Partner",
            orderRefId: "ORD202607170001",
            PartnerInvoice: "INV202607170001",
            ParnerRefNumber: "PRN202607170001",
            statusDescription: "Payment completed successfully",
            createdAt: "2026-07-17",
            amount: "100.00",
            currency: "MYR",
            completedDateTime: "2026-07-17T07:29:55Z",
            PaymentStatus: "SUCCESS",
            PaymentStatusCode: "0000",
            orderStatus: "COMPLETED"
        }
    }, response);

    assert.equal(response.statusCode, 200);
    const savedOrder = database.prepare("SELECT * FROM orders WHERE orderRefId = ?")
        .get("ORD202607170001");
    assert.deepEqual({ ...savedOrder }, {
        orderRefId: "ORD202607170001",
        partnerReferenceId: "PRN202607170001",
        partnerInvoiceId: "INV202607170001",
        currency: "MYR",
        amount: 100,
        createdAt: "2026-07-17T00:00:00.000Z",
        paymentStatus: "SUCCESS",
        orderStatus: "COMPLETED",
        partnerCode: "PAT001",
        partnerName: "PAT001 Demo Partner",
        PartnerInvoice: "INV202607170001",
        ParnerRefNumber: "PRN202607170001",
        statusDescription: "Payment completed successfully",
        completedDateTime: "2026-07-17T07:29:55Z",
        PaymentStatusCode: "0000",
        digitalId: null
    });
});
