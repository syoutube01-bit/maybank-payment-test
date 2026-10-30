import { useRef, useState } from "react";
import { PageStyle } from "../components/PageStyle";
import { buildPartnerInvoiceId, detectNativePlatform, readWebInitToken, toDeepLink } from "../lib/payment";
import css from "../styles/dp-landing.css?inline";

const DP_ORDERS_URL = "/api/dp/create-order";
const DP_CREATE_ORDER_BODY = {
    "partnerReferenceId": "REF20260522",
    "currency": "MYR",
    "amount": 100,
    "remark": "New Payment order"
};

function triggerRedirection(url) {
    const deepLinkUrl = toDeepLink(url);
    try {
        window.location.href = deepLinkUrl;
    } catch (error) {
        console.warn("[Redirection] Failed to open deep link URL:", deepLinkUrl, error);
    }
}

export default function DPLandingPage() {
    const accessTokenRef = useRef("");
    const tokenRequestRef = useRef(null);
    const [response, setResponse] = useState("");

    function getToken() {
        if (accessTokenRef.current) return Promise.resolve(accessTokenRef.current);
        if (tokenRequestRef.current) return tokenRequestRef.current;

        tokenRequestRef.current = fetch("/api/dp/token", { method: "POST" }).then(async res => {
            const text = await res.text();
            if (!res.ok) {
                throw new Error("Get Token: HTTP " + res.status + "\n" + text);
            }
            const data = JSON.parse(text);
            const token = data?.responseData?.access_token;
            if (data?.txnStatus?.code !== "AOK200" || typeof token !== "string" || !token.trim()) {
                throw new Error("Get Token returned no valid access token: " + text);
            }
            accessTokenRef.current = token;
            return token;
        }).finally(() => {
            tokenRequestRef.current = null;
        });
        return tokenRequestRef.current;
    }

    async function createOrder() {
        setResponse("Loading...");
        try {
            await getToken();
            const webinitToken = await readWebInitToken();
            const res = await fetch(DP_ORDERS_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "text/plain",
                    "X-MB-IDEMPOTENCY-KEY": crypto.randomUUID(),
                    "x-webinit-token": webinitToken,
                    "x-access-token": accessTokenRef.current
                },
                body: JSON.stringify({
                    ...DP_CREATE_ORDER_BODY,
                    partnerInvoiceId: buildPartnerInvoiceId()
                })
            });
            const text = await res.text();
            setResponse("HTTP " + res.status + "\n" + text);

            let data;
            try {
                data = JSON.parse(text);
            } catch {
                return;
            }

            if (res.ok && data.statusCode === "0000") {
                const platform = detectNativePlatform();
                const redirection = data.redirection;
                const redirectionUrl = redirection
                    ? platform === "ios" ? redirection.ios : redirection.android
                    : "";

                if (redirectionUrl) {
                    triggerRedirection(redirectionUrl);
                } else {
                    console.warn("[Redirection] No redirection URL for platform:", platform);
                }
            }
        } catch (error) {
            setResponse("Request failed: " + error.message);
        }
    }

    async function getWithTokens(url) {
        setResponse("Loading...");
        try {
            await getToken();
            const webinitToken = await readWebInitToken();
            const res = await fetch(url, {
                method: "GET",
                headers: { "x-webinit-token": webinitToken, "x-access-token": accessTokenRef.current }
            });
            const text = await res.text();
            setResponse("HTTP " + res.status + "\n" + text);
        } catch (error) {
            setResponse("Request failed: " + error.message);
        }
    }

    function viewParty() {
        return getWithTokens("/api/dp/view-party");
    }

    function getOrderByRefId() {
        const orderRefId = window.prompt("Enter Order Reference Id", "MBB393");
        if (!orderRefId) return;
        return getWithTokens("/api/dp/order-status?orderRefId=" + encodeURIComponent(orderRefId));
    }

    function getOrderByInvoiceId() {
        const partnerInvoiceId = window.prompt("Enter Partner Invoice Id", "INV20260914212");
        if (!partnerInvoiceId) return;
        return getWithTokens("/api/dp/order-by-invoice?partnerInvoiceId=" + encodeURIComponent(partnerInvoiceId));
    }

    return (
        <>
            <title>DP Landing Screen</title>
            <PageStyle css={css} />
            <h2>DP Landing Screen</h2>
            <div className="layout">
                <div className="left">
                    <button id="createOrderBtn" onClick={createOrder}>Create Order</button>
                    <button id="viewPartyBtn" onClick={viewParty}>View Party</button>
                    <button id="getByOrderRefBtn" onClick={getOrderByRefId}>Get Order by Order Reference Id</button>
                    <button id="getByInvoiceBtn" onClick={getOrderByInvoiceId}>Get Order by Partner Invoice Id</button>
                </div>
                <div className="right">
                    <h3>Response</h3>
                    <pre id="response" aria-live="polite">{response}</pre>
                </div>
            </div>
        </>
    );
}
