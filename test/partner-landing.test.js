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
    return { handler: routes.get("/"), middleware };
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

test("each partner page has a distinct landing and returns to the API test screen", () => {
    const expectedHeadings = {
        "easybook-landing.html": "Easybook",
        "esim-landing.html": "eSIM",
        "ctos-landing.html": "CTOS"
    };

    for (const [page, heading] of Object.entries(expectedHeadings)) {
        const html = fs.readFileSync(path.join(root, "public", page), "utf8");
        assert.match(html, new RegExp(`<h1>${heading}</h1>`));
        assert.match(html, /class="api-test"[^>]*>API test<\/a>/);
        assert.match(html, /href \+= window\.location\.search/);
        if (page === "ctos-landing.html") {
            assert.doesNotMatch(html, /width:\s*1px;[\s\S]*?clip:\s*rect\(0,\s*0,\s*0,\s*0\)/);
        }
    }
});
