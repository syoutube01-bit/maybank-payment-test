const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { once } = require("node:events");
const { test } = require("node:test");
const express = require("express");
const { createPostgresMock } = require("./postgres-test-pool");

test("API errors are JSON over HTTP without changing page responses", async t => {
    const app = express();
    const listen = app.listen;
    app.listen = () => {};
    const root = path.join(__dirname, "..");
    const errors = [];
    const postgres = createPostgresMock();
    const context = vm.createContext({
        require: name => name === "express" ? Object.assign(() => app, express)
            : name === "pg" ? postgres
                : require(name),
        __dirname: root,
        process: { ...process, env: { ...process.env, DATABASE_URL: "postgres://test" } },
        console: { log() {}, error: (...args) => errors.push(args) }
    });
    vm.runInContext(fs.readFileSync(path.join(root, "server.js"), "utf8"), context);
    const database = postgres.database;
    const server = listen.call(app, 0, "127.0.0.1");
    t.after(async () => {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        database.close();
    });
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    async function expectJson(url, options, status, message) {
        const response = await fetch(baseUrl + url, options);
        assert.equal(response.status, status);
        assert.match(response.headers.get("content-type"), /^application\/json/);
        assert.deepEqual(await response.json(), { success: false, message });
    }

    await t.test("unknown API routes and unsupported methods return JSON 404", async () => {
        for (const method of ["GET", "POST"]) {
            await expectJson("/api/unknown", { method }, 404, "API endpoint not found");
        }
        await expectJson("/api/local/orders/payment-status", { method: "PUT" }, 404, "API endpoint not found");
    });

    await t.test("registered payment status route returns JSON errors", async () => {
        await expectJson("/api/local/orders/payment-status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orderRefId: "MBB768", paymentStatus: "SUCCESS" })
        }, 404, "Order not found");
    });

    await t.test("order reference lookup returns the stored order as JSON", async () => {
        database.prepare(`INSERT INTO orders (
            order_ref_id, partner_reference_id, partner_invoice_id, currency, amount,
            created_at, payment_status, order_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run("MBB777", "REF777", "INV15486272711", "MYR", 100, "2026-10-23", "PENDING", "CREATED");
        const response = await fetch(baseUrl + "/api/local/orders/MBB777");
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /^application\/json/);
        const result = await response.json();
        assert.equal(result.data.orderRefId, "MBB777");
        assert.equal(result.data.paymentStatus, "PENDING");
        await expectJson("/api/local/orders/missing", {}, 404, "Order not found");
    });

    await t.test("malformed JSON returns JSON 400 instead of Express HTML", async () => {
        await expectJson("/api/local/orders/payment-status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: '{"orderRefId":'
        }, 400, "Request body must contain valid JSON");
        assert.equal(errors.length, 1);
    });

    await t.test("existing HTML pages still work", async () => {
        const response = await fetch(baseUrl + "/paymentstatus");
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /^text\/html/);
        await response.text();
    });
});
