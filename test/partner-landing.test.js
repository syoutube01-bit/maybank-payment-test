const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const partnerPages = {
    "mbb-mae-easybook": "easybook-landing.html",
    "mbb-mae-esim": "esim-landing.html",
    "mbb-mae-ctos": "ctos-landing.html"
};

function loadLandingRoute() {
    const routes = new Map();
    const middleware = [];
    const app = {
        use(handler) { middleware.push(handler); },
        get(route, handler) { routes.set(route, handler); },
        post() {},
        listen() {}
    };
    const express = Object.assign(() => app, {
        json() {},
        urlencoded() {},
        static() { return () => {}; },
        text() {}
    });
    const context = vm.createContext({
        require(name) {
            if (name === "express") return express;
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
        console: { log() {}, error() {} }
    });
    vm.runInContext(fs.readFileSync(path.join(root, "server.js"), "utf8"), context);
    return { handler: routes.get("/"), middleware, routes };
}

test("partner IDs redirect to their own landing pages and preserve query parameters", () => {
    const { handler } = loadLandingRoute();

    for (const [partnerId, page] of Object.entries(partnerPages)) {
        const response = {
            redirect(status, location) {
                this.statusCode = status;
                this.location = location;
            }
        };
        let passedThrough = false;
        handler({
            query: { partnerId },
            originalUrl: `/?partnerId=${partnerId}&source=checkout`
        }, response, () => { passedThrough = true; });

        assert.equal(response.statusCode, 302);
        assert.equal(response.location, `/${page}?partnerId=${partnerId}&source=checkout`);
        assert.equal(passedThrough, false);
    }
});

test("unknown and missing partner IDs retain the existing landing screen", () => {
    const { handler } = loadLandingRoute();

    for (const partnerId of ["unknown", "constructor", undefined]) {
        let passedThrough = false;
        handler({
            query: { partnerId },
            originalUrl: "/"
        }, {}, () => { passedThrough = true; });
        assert.equal(passedThrough, true);
    }
});

test("server serves the React app shell for every original page path", () => {
    const { routes } = loadLandingRoute();
    const expectedPaths = [
        "/", "/index.html", "/DPLandingScreen.html", "/PNTOrderCreation.html", "/ctos-landing.html",
        "/easybook-landing.html", "/esim-landing.html", "/my-orders.html", "/paymentstatus",
        "/paymentstatus.html", "/lookup-payment-status.html"
    ];
    // The SPA route is registered with an array path, so the mock stores it under that array.
    const spaRoute = [...routes.keys()].find(route => Array.isArray(route));
    assert.ok(spaRoute, "No GET route registered with an array of paths");
    assert.deepEqual([...spaRoute], expectedPaths);

    let sentFile;
    routes.get(spaRoute)({}, { sendFile(file) { sentFile = file; } });
    assert.equal(sentFile, path.join(root, "dist", "index.html"));
});
