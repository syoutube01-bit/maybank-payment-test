const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const upstreamUrl = "https://staging.api.maybank.com/api/my/microsite/v1/view/party";

function loadViewPartyRoute(upstream = { status: 200, data: "encrypted-response" }) {
    const routes = new Map();
    const requests = [];
    const signatures = [];
    const decryptedBodies = [];
    const app = {
        use() {},
        get(route, ...handlers) { routes.set(route, handlers); },
        post() {},
        listen() {}
    };
    const express = Object.assign(() => app, {
        json() {}, urlencoded() {}, static() {}, text() {}
    });
    const context = vm.createContext({
        require(name) {
            if (name === "express") return express;
            if (name === "axios") return {
                getUri: require("axios").getUri,
                async request(config) {
                    requests.push(config);
                    return { ...upstream };
                }
            };
            return require(name);
        },
        __dirname: root,
        process: { ...process, env: { ...process.env, DATABASE_URL: "" } },
        console: { log() {}, error() {} },
        signatures,
        decryptedBodies
    });
    vm.runInContext(fs.readFileSync(path.join(root, "server.js"), "utf8") + `
        signDpHeaders = (method, url, headers, body) => {
            signatures.push({ method, url, headers: { ...headers }, body });
            return "test-signature";
        };
        decryptDpBody = async body => {
            decryptedBodies.push(body);
            return '{"party":"test-party"}';
        };
    `, context);
    const handlers = routes.get("/api/dp/view-party");
    const response = {
        headers: {},
        status(code) { this.statusCode = code; return this; },
        type(value) { this.contentType = value; return this; },
        set(name, value) { this.headers[name] = value; return this; },
        send(body) { this.body = body; return this; }
    };
    return { handler: handlers.at(-1), requireAccessToken: handlers[1], requests, signatures, decryptedBodies, response };
}

const request = {
    get: name => ({
        "x-access-token": "test-access-token",
        "x-webinit-token": "test-webinit-token"
    })[name]
};

test("view party matches the working curl method, URL, body and headers", async () => {
    const { handler, requests, signatures, decryptedBodies, response } = loadViewPartyRoute();
    await handler(request, response);

    assert.equal(requests.length, 1);
    const config = requests[0];
    assert.equal(config.method, "get");
    assert.equal(config.url, upstreamUrl);
    assert.equal(require("axios").getUri(config), upstreamUrl);
    assert.equal(config.params, undefined);
    assert.equal(config.data, undefined);
    assert.deepEqual(Object.keys(config.headers).sort(), [
        "Content-Type", "X-MB-Timestamp", "X-MB-API-KEY", "X-MB-E2E-Id",
        "X-MB-Authorization", "X-MB-Client-Id", "X-MB-ENV", "X-MB-Signature-Alg",
        "X-MB-Signed-Headers", "X-MB-Signature-Value", "dip-authorization"
    ].sort());
    assert.equal(config.headers["Content-Type"], "text/plain");
    assert.equal(config.headers["X-MB-Authorization"], "test-access-token");
    assert.equal(config.headers["dip-authorization"], "bearer test-webinit-token");
    assert.equal(config.headers["X-MB-ENV"], "U");
    assert.equal(config.headers["X-MB-Signature-Alg"], "RSA-SHA256");
    assert.equal(config.headers["X-MB-Signed-Headers"], "X-MB-Client-Id;X-MB-Authorization;X-MB-Timestamp");
    assert.equal(config.headers["X-MB-Signature-Value"], "test-signature");
    assert.match(config.headers["X-MB-Timestamp"], /^\d+$/);
    assert.match(config.headers["X-MB-E2E-Id"], /^[a-f0-9]{32}$/);
    assert.equal(signatures.length, 1);
    assert.equal(signatures[0].method, "get");
    assert.equal(signatures[0].url, upstreamUrl);
    assert.equal(signatures[0].body, undefined);
    assert.deepEqual(decryptedBodies, ["encrypted-response"]);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, '{"party":"test-party"}');
});

test("view party preserves upstream errors and response metadata", async () => {
    const body = '{"status":400,"error":"Bad Request","path":"/customer/v3/view-party"}';
    const { handler, response, decryptedBodies } = loadViewPartyRoute({
        status: 400, data: body, headers: { "x-mb-e2e-id": "test-e2e-id" }
    });
    await handler(request, response);
    assert.equal(response.statusCode, 400);
    assert.equal(response.body, body);
    assert.equal(response.headers["x-mb-e2e-id"], "test-e2e-id");
    assert.deepEqual(decryptedBodies, []);
});

test("view party still requires an access token before sending an upstream request", () => {
    const { requireAccessToken, response, requests } = loadViewPartyRoute();
    requireAccessToken({ get: () => "" }, response, () => assert.fail("Must reject missing token"));
    assert.equal(response.statusCode, 401);
    assert.match(response.body, /access_token is required/);
    assert.equal(requests.length, 0);
});
