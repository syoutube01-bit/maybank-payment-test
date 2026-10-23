(() => {
    // Keep the native initialization token only for this page's lifetime.
    const EXPIRY_SKEW_MS = 30 * 1000;
    let cachedToken;
    let pendingToken;

    function isExpired(token) {
        try {
            const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
            const exp = JSON.parse(atob(payload))?.exp;
            return typeof exp === "number" && exp * 1000 - EXPIRY_SKEW_MS <= Date.now();
        } catch {
            return false;
        }
    }

    function requestNativeToken() {
        return (async () => {
            if (!window.nativeMessageService) {
                throw new Error("Native payment bridge unavailable. Open this page in the MAE app.");
            }
            const response = await window.nativeMessageService.callAPI("GET_INIT_TOKEN", {});
            if (typeof response?.webInitToken !== "string" || !response.webInitToken.trim()) {
                throw new Error("Native app returned no valid web-init token.");
            }
            return response.webInitToken;
        })();
    }

    window.paymentSession = {
        // Reuses the cached token while it is unexpired; otherwise asks the native app for a new one.
        getWebInitToken() {
            if (cachedToken && !isExpired(cachedToken)) {
                return Promise.resolve(cachedToken);
            }
            cachedToken = undefined;
            if (!pendingToken) {
                pendingToken = requestNativeToken().then(token => {
                    cachedToken = token;
                    pendingToken = undefined;
                    return token;
                }, error => {
                    pendingToken = undefined;
                    throw new Error("Get Web Init Token: " + error.message);
                });
            }
            return pendingToken;
        }
    };
})();
