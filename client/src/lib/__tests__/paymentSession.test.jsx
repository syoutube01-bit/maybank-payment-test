import { afterEach, expect, test } from "vitest";
import { createPaymentSession } from "../paymentSession";
import { webInitJwt } from "../../test/utils";

afterEach(() => {
    delete window.nativeMessageService;
});

test("concurrent web-init requests share one native call and keep the resolved token", async () => {
    let calls = 0;
    let resolve;
    window.nativeMessageService = {
        callAPI(method, body) {
            calls++;
            expect(method).toBe("GET_INIT_TOKEN");
            expect(JSON.stringify(body)).toBe("{}");
            return new Promise(done => { resolve = done; });
        }
    };
    const session = createPaymentSession();
    const first = session.getWebInitToken();
    const second = session.getWebInitToken();
    expect(first).toBe(second);
    resolve({ webInitToken: "native-token" });
    expect(await first).toBe("native-token");
    expect(await session.getWebInitToken()).toBe("native-token");
    expect(calls).toBe(1);
});

test("missing bridge fails explicitly and allows retry after bridge injection", async () => {
    const session = createPaymentSession();
    await expect(session.getWebInitToken()).rejects.toThrow(/Get Web Init Token: Native payment bridge unavailable/);
    window.nativeMessageService = { async callAPI() { return { webInitToken: "native-token" }; } };
    expect(await session.getWebInitToken()).toBe("native-token");
});

test("blank or malformed native token responses are not cached", async () => {
    for (const response of [undefined, null, {}, { webInitToken: "" }, { webInitToken: " " }, { webInitToken: 123 }]) {
        let calls = 0;
        window.nativeMessageService = {
            async callAPI() {
                calls++;
                return calls === 1 ? response : { webInitToken: "valid-token" };
            }
        };
        const session = createPaymentSession();
        await expect(session.getWebInitToken()).rejects.toThrow(/no valid web-init token/);
        expect(await session.getWebInitToken()).toBe("valid-token");
        expect(calls).toBe(2);
    }
});

test("an unexpired token is reused and an expiring token is replaced by a new native token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tokens = [webInitJwt({ did: "user-a", exp: now + 3600 }), webInitJwt({ did: "user-a", exp: now + 10 }),
        webInitJwt({ did: "user-a", exp: now + 3600 })];
    let calls = 0;
    window.nativeMessageService = { async callAPI() { return { webInitToken: tokens[calls++] }; } };
    const session = createPaymentSession();
    expect(await session.getWebInitToken()).toBe(tokens[0]);
    expect(await session.getWebInitToken()).toBe(tokens[0]);
    expect(calls).toBe(1);

    const expiring = createPaymentSession();
    expect(await expiring.getWebInitToken()).toBe(tokens[1]);
    expect(await expiring.getWebInitToken()).toBe(tokens[2]);
    expect(await expiring.getWebInitToken()).toBe(tokens[2]);
    expect(calls).toBe(3);
});

test("a new page session retrieves its own native token", async () => {
    let calls = 0;
    window.nativeMessageService = { async callAPI() { return { webInitToken: "token-" + ++calls }; } };
    expect(await createPaymentSession().getWebInitToken()).toBe("token-1");
    expect(await createPaymentSession().getWebInitToken()).toBe("token-2");
});
