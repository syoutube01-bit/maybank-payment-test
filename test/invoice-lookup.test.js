const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");

function loadInvoiceRoute() {
    const routes = new Map();
    const requests = [];
    const signedUrls = [];
    const app = {
        use() {},
        get(route, ...handlers) { routes.set(route, handlers.at(-1)); },
        post() {},
        listen() {}
    };
    const express = Object.assign(() => app, {
        json() {}, urlencoded() {}, static() {}, text() {}
    });
    const axios = {
        getUri: require("axios").getUri,
        async request(config) {
            requests.push(config);
            return { status: 200, data: '{"statusCode":"0000"}' };
        }
    };
    const context = vm.createContext({
        require(name) {
            if (name === "express") return express;
            if (name === "axios") return axios;
            if (name === "pg") return {
                Pool: class {
                    async query() {
                        return { rows: [], rowCount: 0 };
                    }
                }
            };
            return require(name);
        },
        __dirname: root,
        process: { ...process, env: { ...process.env, DATABASE_URL: "postgres://test" } },
        console: { log() {}, error() {} },
        signedUrls
    });
    vm.runInContext(fs.readFileSync(path.join(root, "server.js"), "utf8") + `
        signDpHeaders = (method, url) => { signedUrls.push(url); return "test-signature"; };
        decryptDpBody = async body => body;
    `, context);
    return { handler: routes.get("/api/dp/order-by-invoice"), requests, signedUrls };
}

test("invoice lookup uses the cURL query name in the upstream and signed URLs", async () => {
    for (const query of [
        { partnerInvoiceId: "INV99131040927" },
        { invoiceId: "INV99131040927" },
        { partnerInvoiceId: "INV99131040927", invoiceId: "legacy-value" }
    ]) {
        const { handler, requests, signedUrls } = loadInvoiceRoute();
        const response = {
            status(code) { this.statusCode = code; return this; },
            type() { return this; },
            send(body) { this.body = body; return this; }
        };
        await handler({
            query,
            get: name => name === "x-access-token" ? "test-access-token" : "test-webinit-token"
        }, response);
        const request = requests[0];
        const url = new URL(require("axios").getUri(request));
        assert.equal(url.href, "https://staging.api.maybank.com/api/my/microsite/v1/order/partner/invoice?partnerInvoiceId=INV99131040927");
        assert.equal(signedUrls[0], url.href);
        assert.equal(request.method, "get");
        assert.equal(request.headers["Content-Type"], "text/plain");
        assert.equal(request.headers["X-MB-Authorization"], "test-access-token");
        assert.equal(request.headers["dip-authorization"], "bearer test-webinit-token");
        assert.equal(response.statusCode, 200);
    }
});

test("invalid invoice parameters are rejected without an upstream call", async () => {
    for (const query of [{}, { partnerInvoiceId: "" }, { partnerInvoiceId: ["INV1", "INV2"] }]) {
        const { handler, requests } = loadInvoiceRoute();
        const response = {
            status(code) { this.statusCode = code; return this; },
            send(body) { this.body = body; return this; }
        };
        await handler({ query }, response);
        assert.equal(response.statusCode, 400);
        assert.equal(response.body, "partnerInvoiceId is required");
        assert.equal(requests.length, 0);
    }
});

test("the page sends an encoded partnerInvoiceId", async () => {
    const html = fs.readFileSync(path.join(root, "public", "DPLandingScreen.html"), "utf8");
    const output = {};
    let requestedUrl;
    const context = vm.createContext({
        document: { getElementById: () => ({ addEventListener() {}, ...output }) },
        prompt: () => "INV /+?",
        window: {},
        async fetch(url) {
            requestedUrl = url;
            return { status: 200, text: async () => "{}" };
        }
    });
    vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
    await vm.runInContext('accessToken = "test-access-token"; getOrderByInvoiceId();', context);
    assert.equal(requestedUrl, "/api/dp/order-by-invoice?partnerInvoiceId=INV%20%2F%2B%3F");
});
