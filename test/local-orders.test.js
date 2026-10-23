const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function loadOrdersRoute(t) {
    const routes = new Map();
    const errors = [];
    const app = {
        use() {}, post() {}, listen() {},
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
    return { handler: routes.get("/api/local/orders"), database, response, errors };
}

test("local orders returns an empty list from a new database", t => {
    const { handler, response } = loadOrdersRoute(t);
    handler({}, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { success: true, data: [] });
});

test("local orders returns all eight columns, newest first with deterministic ties", t => {
    const { handler, database, response } = loadOrdersRoute(t);
    const orders = [
        ["MBB1", "REF1", "INV1", "MYR", 100, "2026-10-22", "PENDING", "CREATED"],
        ["MBB2", "REF2", "INV2", "MYR", 200, "2026-10-23", "PAID", "COMPLETED"],
        ["MBB3", "REF3", "INV3", "MYR", 300, "2026-10-23", "PENDING", "CREATED"]
    ];
    for (const order of orders) database.prepare("INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(...order);
    handler({}, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.deepEqual(response.body.data.map(order => Object.values(order)), orders.toReversed());
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
