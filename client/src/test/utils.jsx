import { render } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { vi } from "vitest";
import App from "../App";

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const validToken = { txnStatus: { code: "AOK200" }, responseData: { access_token: "access-token" } };

export function response(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async text() { return JSON.stringify(data); },
        async json() { return data; }
    };
}

export function textResponse(text, status = 200) {
    return { ok: status >= 200 && status < 300, status, async text() { return text; } };
}

export function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

function LocationDisplay({ navigations }) {
    const location = useLocation();
    const url = location.pathname + location.search;
    const initial = useRef(true);
    useEffect(() => {
        if (initial.current) {
            initial.current = false;
            return;
        }
        navigations.push(url);
    }, [location.key]);
    return <output data-testid="location">{url}</output>;
}

// Renders `ui` (default: the whole SPA) inside a MemoryRouter at the given URL and exposes
// the current router location plus every router navigation made after the first render.
export function renderApp(url, ui = <App />) {
    const navigations = [];
    const result = render(
        <MemoryRouter initialEntries={[url]}>
            {ui}
            <LocationDisplay navigations={navigations} />
        </MemoryRouter>
    );
    return { ...result, navigations, location: () => result.getByTestId("location").textContent };
}

export function stubFetch(implementation) {
    const fetch = vi.fn(implementation);
    vi.stubGlobal("fetch", fetch);
    return fetch;
}

// Deep links still assign window.location.href; capture them instead of letting jsdom navigate.
export function stubLocation(search = "") {
    const location = { href: "", search, pathname: "/", hash: "", assign: vi.fn(), replace: vi.fn() };
    vi.stubGlobal("location", location);
    return location;
}

export function stubBridge(callAPI) {
    const bridge = { callAPI: vi.fn(callAPI) };
    window.nativeMessageService = bridge;
    return bridge;
}

export function setPlatform(platform) {
    Object.defineProperty(window.navigator, "platform", { value: platform, configurable: true });
}

export function webInitJwt(claims) {
    const payload = btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return "header." + payload + ".sig";
}

export function pageStyles(container = document) {
    return [...container.querySelectorAll("style")].map(style => style.textContent).join("\n");
}
