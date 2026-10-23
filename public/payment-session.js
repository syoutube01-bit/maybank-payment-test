(() => {
    // Keep the native initialization token only for this page's lifetime.
    let webInitTokenPromise;

    window.paymentSession = {
        getWebInitToken() {
            if (!webInitTokenPromise) {
                webInitTokenPromise = (async () => {
                    if (!window.nativeMessageService) {
                        throw new Error("Native payment bridge unavailable. Open this page in the MAE app.");
                    }
                    const response = await window.nativeMessageService.callAPI("GET_INIT_TOKEN", {});
                    if (typeof response?.webInitToken !== "string" || !response.webInitToken.trim()) {
                        throw new Error("Native app returned no valid web-init token.");
                    }
                    return response.webInitToken;
                })().catch(error => {
                    webInitTokenPromise = undefined;
                    throw new Error("Get Web Init Token: " + error.message);
                });
            }
            return webInitTokenPromise;
        }
    };
})();
