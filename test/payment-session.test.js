const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const script = fs.readFileSync(path.join(__dirname, "../public/payment-session.js"), "utf8");

function loadSession(bridge) {
    const window = { nativeMessageService: bridge };
    vm.runInNewContext(script, { window, atob });
    return window;
}

test("concurrent web-init requests share one native call and keep the resolved token", async () => {
    let calls = 0;
    let resolve;
    const window = loadSession({
        callAPI(method, body) {
            calls++;
            assert.equal(method, "GET_INIT_TOKEN");
            assert.equal(JSON.stringify(body), "{}");
            return new Promise(done => { resolve = done; });
        }
    });
    const first = window.paymentSession.getWebInitToken();
    const second = window.paymentSession.getWebInitToken();
    assert.equal(first, second);
    resolve({ webInitToken: "native-token" });
    assert.equal(await first, "native-token");
    assert.equal(await window.paymentSession.getWebInitToken(), "native-token");
    assert.equal(calls, 1);
});

test("missing bridge fails explicitly and allows retry after bridge injection", async () => {
    const window = loadSession();
    await assert.rejects(window.paymentSession.getWebInitToken(), /Get Web Init Token: Native payment bridge unavailable/);
    window.nativeMessageService = { async callAPI() { return { webInitToken: "native-token" }; } };
    assert.equal(await window.paymentSession.getWebInitToken(), "native-token");
});

test("blank or malformed native token responses are not cached", async () => {
    for (const response of [undefined, null, {}, { webInitToken: "" }, { webInitToken: " " }, { webInitToken: 123 }]) {
        let calls = 0;
        const window = loadSession({
            async callAPI() {
                calls++;
                return calls === 1 ? response : { webInitToken: "valid-token" };
            }
        });
        await assert.rejects(window.paymentSession.getWebInitToken(), /no valid web-init token/);
        assert.equal(await window.paymentSession.getWebInitToken(), "valid-token");
        assert.equal(calls, 2);
    }
});

function jwt(claims) {
    return "header." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".sig";
}

test("an unexpired token is reused and an expiring token is replaced by a new native token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tokens = [jwt({ did: "user-a", exp: now + 3600 }), jwt({ did: "user-a", exp: now + 10 }),
        jwt({ did: "user-a", exp: now + 3600 })];
    let calls = 0;
    const window = loadSession({ async callAPI() { return { webInitToken: tokens[calls++] }; } });
    assert.equal(await window.paymentSession.getWebInitToken(), tokens[0]);
    assert.equal(await window.paymentSession.getWebInitToken(), tokens[0]);
    assert.equal(calls, 1);

    const expiring = loadSession({ async callAPI() { return { webInitToken: tokens[calls++] }; } });
    assert.equal(await expiring.paymentSession.getWebInitToken(), tokens[1]);
    assert.equal(await expiring.paymentSession.getWebInitToken(), tokens[2]);
    assert.equal(await expiring.paymentSession.getWebInitToken(), tokens[2]);
    assert.equal(calls, 3);
});

test("fresh web-init requests bypass the cached token and replace it", async () => {
    let calls = 0;
    const window = loadSession({ async callAPI() { return { webInitToken: "token-" + ++calls }; } });
    assert.equal(await window.paymentSession.getWebInitToken(), "token-1");
    assert.equal(await window.paymentSession.getFreshWebInitToken(), "token-2");
    assert.equal(await window.paymentSession.getFreshWebInitToken(), "token-3");
    assert.equal(await window.paymentSession.getWebInitToken(), "token-3");
    assert.equal(calls, 3);
});

test("a new page session retrieves its own native token", async () => {
    let calls = 0;
    const bridge = { async callAPI() { return { webInitToken: "token-" + ++calls }; } };
    assert.equal(await loadSession(bridge).paymentSession.getWebInitToken(), "token-1");
    assert.equal(await loadSession(bridge).paymentSession.getWebInitToken(), "token-2");
});
