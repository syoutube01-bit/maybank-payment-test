export function buildPartnerInvoiceId() {
    let digits = "";
    for (let i = 0; i < 11; i++) {
        digits += Math.floor(Math.random() * 10);
    }
    return "INV" + digits;
}

// navigator.userAgent is overridden to "Maybank-MY" by SecureWebView, so it can't
// tell iOS from Android; navigator.platform is untouched by that override.
export function detectNativePlatform() {
    const platform = (navigator.platform || "").toLowerCase();
    if (/iphone|ipad|ipod|mac/.test(platform)) return "ios";
    if (/linux|android/.test(platform)) return "android";
    return "unknown";
}

export function toDeepLink(url) {
    return url.replace(/^https:\/\//, "m2ulife://");
}

// WEB_INIT_TOKEN is pulled on demand from the SecureWebView bridge (never
// injected on window), so the native layer can verify origin and re-mint
// an expired token on each request. Failures resolve to an empty token.
export function readWebInitToken() {
    if (!window.nativeMessageService) return Promise.resolve("");
    return window.nativeMessageService
        .callAPI("GET_INIT_TOKEN", {})
        .then(res => (res && res.webInitToken) || "")
        .catch(() => "");
}

export async function getDpAccessToken() {
    const res = await fetch("/api/dp/token", { method: "POST" });
    const text = await res.text();
    if (!res.ok) {
        throw new Error("Get Token: HTTP " + res.status + "\n" + text);
    }
    const data = JSON.parse(text);
    const token = data?.responseData?.access_token;
    if (data?.txnStatus?.code !== "AOK200" || typeof token !== "string" || !token.trim()) {
        throw new Error("Get Token returned no valid access token: " + text);
    }
    return token;
}

// Creates a DP order for a partner landing page and opens the native payment deep link.
export async function createPartnerOrder(paymentSession, accessToken, { partnerId, amount, remark }) {
    const webInitToken = await paymentSession.getWebInitToken();
    const res = await fetch("/api/dp/create-order", {
        method: "POST",
        headers: {
            "Content-Type": "text/plain",
            "X-MB-IDEMPOTENCY-KEY": crypto.randomUUID(),
            "x-webinit-token": webInitToken,
            "x-access-token": accessToken,
            "x-partner-id": partnerId
        },
        body: JSON.stringify({
            partnerReferenceId: "REF20260522",
            currency: "MYR",
            amount,
            remark,
            partnerInvoiceId: buildPartnerInvoiceId()
        })
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error("Create Order: HTTP " + res.status + "\n" + text);
    }
    const data = JSON.parse(text);
    if (data.statusCode !== "0000") {
        throw new Error("Create Order failed: " + text);
    }
    const platform = detectNativePlatform();
    const redirectionUrl = platform === "ios" ? data.redirection?.ios : data.redirection?.android;
    if (typeof redirectionUrl !== "string" || !redirectionUrl.trim()) {
        throw new Error("No redirection URL for platform: " + platform);
    }
    window.location.href = toDeepLink(redirectionUrl);
}
