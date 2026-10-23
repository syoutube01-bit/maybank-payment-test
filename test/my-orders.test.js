const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");

function loadServer(t, databasePath = ":memory:") {
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
        process: { ...process, env: { ...process.env, LOCAL_DB_PATH: databasePath } },
        console: { log() {}, error: (...args) => errors.push(args) }
    });
    vm.runInContext(fs.readFileSync(path.join(root, "server.js"), "utf8"), context);
    const database = vm.runInContext("getOrderDatabase()", context);
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

function call(handler, token) {
    const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; }
    };
    handler({ get: name => name.toLowerCase() === "x-webinit-token" ? token : undefined }, res);
    return res;
}

function order(orderRefId, amount, createdAt) {
    return {
        orderRefId, partnerReferenceId: "REF" + orderRefId, partnerInvoiceId: "INV" + orderRefId,
        currency: "MYR", amount, createdAt
    };
}

test("orders are saved with digitalId and only the owner's orders are returned", t => {
    const { persist, myOrders, database } = loadServer(t);
    persist(order("MBB1", 100, "2026-10-21T00:00:00.000Z"), {}, "user-a");
    persist(order("MBB2", 250, "2026-10-23T00:00:00.000Z"), {}, "user-a");
    persist(order("MBB3", 300, "2026-10-22T00:00:00.000Z"), {}, "user-b");
    persist(order("MBB4", 400, "2026-10-22T00:00:00.000Z"), {}, null);
    database.prepare("UPDATE orders SET paymentStatus = 'SUCCESS' WHERE orderRefId = 'MBB1'").run();

    const res = call(myOrders, jwt({ did: " user-a ", digitalID: "user-b", sub: "user-b" }));
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
    assert.deepEqual(call(myOrders, jwt({ did: "nobody" })).body, { success: true, data: [] });
});

test("re-saving an order without a digitalId keeps the original owner", t => {
    const { persist, database } = loadServer(t);
    persist(order("MBB1", 100, "2026-10-21"), {}, "user-a");
    persist(order("MBB1", 100, "2026-10-21"), {}, null);
    assert.equal(database.prepare("SELECT digitalId FROM orders").get().digitalId, "user-a");
});

test("my orders rejects missing, malformed, expired or did-less tokens", t => {
    const { myOrders } = loadServer(t);
    for (const token of [
        undefined, "", "not-a-jwt", "a.b", "a.%%%.c",
        jwt({ sub: "user-a" }), jwt({ digitalID: "user-a" }),
        jwt({ did: "   " }), jwt({ did: 123 }),
        jwt({ did: "user-a", exp: Math.floor(Date.now() / 1000) - 60 })
    ]) {
        const res = call(myOrders, token);
        assert.equal(res.statusCode, 401, String(token));
        assert.equal(res.body.success, false);
    }
    assert.equal(call(myOrders, "Bearer " + jwt({ did: "user-a",
        exp: Math.floor(Date.now() / 1000) + 60 })).statusCode, 200);
});

test("existing databases are migrated to include the digitalId column", t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orders-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "orders.sqlite");
    const legacy = new DatabaseSync(file);
    legacy.exec(`CREATE TABLE orders (
        orderRefId TEXT PRIMARY KEY, partnerReferenceId TEXT NOT NULL, partnerInvoiceId TEXT NOT NULL,
        currency TEXT NOT NULL, amount INTEGER NOT NULL, createdAt TEXT NOT NULL,
        paymentStatus TEXT NOT NULL, orderStatus TEXT NOT NULL)`);
    legacy.close();

    const { persist, myOrders } = loadServer(t, file);
    persist(order("MBB9", 100, "2026-10-23"), {}, "user-a");
    assert.deepEqual(call(myOrders, jwt({ did: "user-a" })).body.data.map(o => o.orderRefId), ["MBB9"]);
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
            get: name => name === "x-webinit-token" ? token : "access-token",
            body: { partnerInvoiceId: id, partnerReferenceId: "REF1", currency: "MYR", amount: 100 }
        }, res);
        assert.equal(res.statusCode, 201);
        assert.equal(database.prepare("SELECT digitalId FROM orders WHERE orderRefId = ?").get(id).digitalId, did);
        assert.deepEqual(call(myOrders, token).body.data.map(order => order.orderRefId), [id]);
    }
    assert.deepEqual(call(myOrders, jwt({ did: "wrong-user" })).body.data, []);
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
