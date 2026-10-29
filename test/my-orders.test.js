const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { createPostgresMock } = require("./postgres-test-pool");

function loadServer(t) {
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
    const postgres = createPostgresMock();
    const context = vm.createContext({
        require: name => name === "express" ? express
            : name === "pg" ? postgres
                : require(name),
        __dirname: root,
        process: { ...process, env: { ...process.env, DATABASE_URL: "postgres://test" } },
        console: { log() {}, error: (...args) => errors.push(args) }
    });
    vm.runInContext(fs.readFileSync(path.join(root, "server.js"), "utf8"), context);
    const database = postgres.database;
    t.after(() => database.close());
    return {
        context, database, errors,
        persist: vm.runInContext("persistOrderResponse", context),
        myOrders: routes.get("/api/my/orders"),
        createDpOrder: routes.get("POST /api/dp/create-order")
    };
}

function jwt(claims) {
    return "eyJhbGciOiJSUzI1NiJ9." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".sig";
}

async function callAsync(handler, token) {
    const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; }
    };
    await handler({ get: name => name.toLowerCase() === "x-webinit-token" ? token : undefined }, res);
    return res;
}

function order(orderRefId, amount, createdAt) {
    return {
        orderRefId, partnerReferenceId: "REF" + orderRefId, partnerInvoiceId: "INV" + orderRefId,
        currency: "MYR", amount, createdAt
    };
}

test("orders are saved with digitalId and only the owner's orders are returned", async t => {
    const { persist, myOrders, database } = loadServer(t);
    await persist(order("MBB1", 100, "2026-10-21T00:00:00.000Z"), {}, "user-a");
    await persist(order("MBB2", 250, "2026-10-23T00:00:00.000Z"), {}, "user-a");
    await persist(order("MBB3", 300, "2026-10-22T00:00:00.000Z"), {}, "user-b");
    await persist(order("MBB4", 400, "2026-10-22T00:00:00.000Z"), {}, null);
    database.prepare("UPDATE orders SET payment_status = 'SUCCESS' WHERE order_ref_id = 'MBB1'").run();

    const res = await callAsync(myOrders, jwt({ did: " user-a ", digitalID: "user-b", sub: "user-b" }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
        success: true,
        data: [
            { orderRefId: "MBB2", paymentStatus: "PENDING", amount: 250, currency: "MYR",
                createdAt: "2026-10-23T00:00:00.000Z", partnerName: null, partnerInvoiceId: "INVMBB2" },
            { orderRefId: "MBB1", paymentStatus: "SUCCESS", amount: 100, currency: "MYR",
                createdAt: "2026-10-21T00:00:00.000Z", partnerName: null, partnerInvoiceId: "INVMBB1" }
        ]
    });
    assert.deepEqual((await callAsync(myOrders, jwt({ did: "nobody" }))).body, { success: true, data: [] });
});

test("re-saving an order without a digitalId keeps the original owner", async t => {
    const { persist, database } = loadServer(t);
    await persist(order("MBB1", 100, "2026-10-21"), {}, "user-a");
    await persist(order("MBB1", 100, "2026-10-21"), {}, null);
    assert.equal(database.prepare("SELECT digital_id FROM orders").get().digital_id, "user-a");
});

test("my orders rejects missing, malformed, expired or did-less tokens", async t => {
    const { myOrders } = loadServer(t);
    for (const token of [
        undefined, "", "not-a-jwt", "a.b", "a.%%%.c",
        jwt({ sub: "user-a" }), jwt({ digitalID: "user-a" }),
        jwt({ did: "   " }), jwt({ did: 123 }),
        jwt({ did: "user-a", exp: Math.floor(Date.now() / 1000) - 60 })
    ]) {
        const res = await callAsync(myOrders, token);
        assert.equal(res.statusCode, 401, String(token));
        assert.equal(res.body.success, false);
    }
    assert.equal((await callAsync(myOrders, "Bearer " + jwt({
        did: "user-a", exp: Math.floor(Date.now() / 1000) + 60
    }))).statusCode, 200);
});

function dpResponse() {
    return {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        type() { return this; },
        send(body) { this.body = body; return this; }
    };
}

test("DP create order persists did and My Orders filters the created orders by did", async t => {
    const { context, database, myOrders, createDpOrder } = loadServer(t);
    vm.runInContext(`
        encryptDpBody = async body => body;
        dpRequest = async (label, method, url, token, options) => ({
            status: 201,
            data: { ...JSON.parse(options.body), orderRefId: JSON.parse(options.body).partnerInvoiceId }
        });
    `, context);
    for (const [id, did] of [["INV1", "user-a"], ["INV2", "user-b"]]) {
        const token = jwt({ did, digitalID: "wrong-user" });
        const res = dpResponse();
        await createDpOrder({
            get: name => name === "x-webinit-token" ? token : name === "x-access-token" ? "access-token" : undefined,
            body: { partnerInvoiceId: id, partnerReferenceId: "REF1", currency: "MYR", amount: 100 }
        }, res);
        assert.equal(res.statusCode, 201);
        assert.equal(database.prepare("SELECT digital_id FROM orders WHERE order_ref_id = ?").get(id).digital_id, did);
        assert.deepEqual((await callAsync(myOrders, token)).body.data.map(order => order.orderRefId), [id]);
    }
    assert.deepEqual((await callAsync(myOrders, jwt({ did: "wrong-user" }))).body.data, []);
});

test("DP create order accepts positive decimal amounts and preserves them in storage", async t => {
    const { context, database, createDpOrder } = loadServer(t);
    vm.runInContext(`
        encryptDpBody = async body => body;
        dpRequest = async (label, method, url, token, options) => ({
            status: 201,
            data: { ...JSON.parse(options.body), orderRefId: JSON.parse(options.body).partnerInvoiceId }
        });
    `, context);
    const token = jwt({ did: "user-a" });
    for (const amount of [100.50, 27.50, 29.90, 0.01, 1.2345]) {
        const partnerInvoiceId = "INV" + String(amount).replace(".", "");
        const res = dpResponse();
        await createDpOrder({
            get: name => name === "x-webinit-token" ? token : name === "x-access-token" ? "access-token" : undefined,
            body: { partnerInvoiceId, partnerReferenceId: "REF1", currency: "MYR", amount }
        }, res);
        assert.equal(res.statusCode, 201);
        assert.equal(res.body.amount, amount);
        assert.equal(database.prepare("SELECT amount FROM orders WHERE order_ref_id = ?")
            .get(partnerInvoiceId).amount, amount);
    }
});

test("DP create order rejects non-positive and invalid amounts before calling upstream", async t => {
    const { context, database, createDpOrder } = loadServer(t);
    vm.runInContext(`
        encryptDpBody = async () => { throw new Error("Encryption must not be called"); };
        dpRequest = async () => { throw new Error("Upstream must not be called"); };
    `, context);
    for (const amount of [0, -1, -27.50, NaN, Infinity, -Infinity, "27.50", null, undefined]) {
        const res = dpResponse();
        await createDpOrder({
            get: () => "access-token",
            body: { partnerInvoiceId: "INV1", partnerReferenceId: "REF1", currency: "MYR", amount }
        }, res);
        assert.equal(res.statusCode, 400);
        assert.equal(res.body, "amount must be a positive number.");
    }
    assert.equal(database.prepare("SELECT count(*) AS count FROM orders").get().count, 0);
});

test("DP create order rejects invalid did tokens before encryption or upstream calls", async t => {
    const { context, database, createDpOrder } = loadServer(t);
    vm.runInContext(`
        encryptDpBody = async () => { throw new Error("Encryption must not be called"); };
        dpRequest = async () => { throw new Error("Upstream must not be called"); };
    `, context);
    for (const token of ["not-a-jwt", jwt({ digitalID: "user-a" }), jwt({ did: "" }),
        jwt({ did: 12 }), jwt({ did: "user-a", exp: 1 })]) {
        const res = dpResponse();
        await createDpOrder({
            get: name => name === "x-webinit-token" ? token : "access-token",
            body: { partnerInvoiceId: "INV1", partnerReferenceId: "REF1", currency: "MYR", amount: 100 }
        }, res);
        assert.equal(res.statusCode, 401);
        assert.match(res.body, /Web-init/);
    }
    assert.equal(database.prepare("SELECT count(*) AS count FROM orders").get().count, 0);
});

async function callWithQuery(handler, token, query) {
    const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; }
    };
    await handler({ query, get: name => name.toLowerCase() === "x-webinit-token" ? token : undefined }, res);
    return res;
}

test("my orders can be filtered to a single landing page partner", async t => {
    const { persist, myOrders } = loadServer(t);
    await persist(order("MBB1", 100, "2026-10-21"), {}, "user-a", "mbb-mae-ctos");
    await persist(order("MBB2", 100, "2026-10-22"), {}, "user-a", "mbb-mae-esim");
    await persist(order("MBB3", 100, "2026-10-23"), {}, "user-b", "mbb-mae-ctos");
    await persist(order("MBB1", 100, "2026-10-21"), {}, "user-a", null);
    const token = jwt({ did: "user-a" });
    const ids = async query => (await callWithQuery(myOrders, token, query)).body.data.map(o => o.orderRefId);
    assert.deepEqual(await ids({ partnerId: "mbb-mae-ctos" }), ["MBB1"]);
    assert.deepEqual(await ids({ partnerId: "mbb-mae-esim" }), ["MBB2"]);
    assert.deepEqual(await ids({ partnerId: "mbb-mae-easybook" }), []);
    assert.deepEqual(await ids({}), ["MBB2", "MBB1"]);
    for (const partnerId of ["", "unknown", "__proto__", ["mbb-mae-ctos", "mbb-mae-esim"]]) {
        const res = await callWithQuery(myOrders, token, { partnerId });
        assert.equal(res.statusCode, 400, String(partnerId));
        assert.equal(res.body.success, false);
    }
});

test("DP create order stores the landing page partner and rejects unknown partners", async t => {
    const { context, database, createDpOrder } = loadServer(t);
    vm.runInContext(`
        encryptDpBody = async body => body;
        dpRequest = async (label, method, url, token, options) => ({
            status: 201,
            data: { ...JSON.parse(options.body), orderRefId: JSON.parse(options.body).partnerInvoiceId }
        });
    `, context);
    const token = jwt({ did: "user-a" });
    for (const [id, partnerId, status] of [["INV1", "mbb-mae-easybook", 201], ["INV2", undefined, 201], ["INV3", "bogus", 400]]) {
        const res = dpResponse();
        await createDpOrder({
            get: name => name === "x-webinit-token" ? token : name === "x-partner-id" ? partnerId : "access-token",
            body: { partnerInvoiceId: id, partnerReferenceId: "REF1", currency: "MYR", amount: 100 }
        }, res);
        assert.equal(res.statusCode, status, id);
    }
    assert.equal(database.prepare("SELECT partner_id FROM orders WHERE order_ref_id = ?").get("INV1").partner_id, "mbb-mae-easybook");
    assert.equal(database.prepare("SELECT partner_id FROM orders WHERE order_ref_id = ?").get("INV2").partner_id, null);
    assert.equal(database.prepare("SELECT count(*) AS count FROM orders").get().count, 2);
});
