const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

test("PostgreSQL mode initializes the snake_case schema and binds query parameters", async () => {
    const queries = [];
    let listeningAfterSchemaCreation = false;
    class MockPool {
        constructor(options) {
            assert.equal(options.connectionString, "postgres://test");
        }

        async query(sql, parameters) {
            queries.push({ sql, parameters });
            return { rows: [], rowCount: 1 };
        }
    }
    const app = {
        use() {},
        listen() {
            listeningAfterSchemaCreation = queries.some(({ sql }) => /CREATE TABLE IF NOT EXISTS orders/.test(sql));
        },
        get() {},
        post() {}
    };
    const express = Object.assign(() => app, {
        json() {}, urlencoded() {}, static() {}, text() {}
    });
    const root = path.join(__dirname, "..");
    const context = vm.createContext({
        require(name) {
            if (name === "express") return express;
            if (name === "pg") return { Pool: MockPool };
            return require(name);
        },
        __dirname: root,
        process: {
            ...process,
            env: { ...process.env, DATABASE_URL: "postgres://test", PGSSL: "" }
        },
        console: { log() {}, error() {} }
    });
    vm.runInContext(fs.readFileSync(path.join(root, "server.js"), "utf8"), context);

    const query = vm.runInContext("queryOrderDatabase", context);
    const result = await query("UPDATE orders SET payment_status = ? WHERE order_ref_id = ?", [
        "SUCCESS", "MBB123"
    ]);

    assert.equal(result.rowCount, 1);
    assert.match(queries[0].sql, /order_ref_id TEXT PRIMARY KEY/);
    assert.match(queries[0].sql, /digital_id TEXT/);
    assert.match(queries[0].sql, /idx_orders_digital_id/);
    assert.equal(queries[1].sql, "UPDATE orders SET payment_status = $1 WHERE order_ref_id = $2");
    assert.deepEqual(queries[1].parameters, ["SUCCESS", "MBB123"]);
    assert.equal(listeningAfterSchemaCreation, true);
});
