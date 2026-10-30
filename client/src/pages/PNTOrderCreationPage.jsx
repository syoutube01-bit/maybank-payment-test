import { useEffect, useState } from "react";
import { PageStyle } from "../components/PageStyle";
import { buildPartnerInvoiceId, detectNativePlatform, readWebInitToken, toDeepLink } from "../lib/payment";
import css from "../styles/pnt-order-creation.css?inline";

// Calls the platform-specific redirection URL returned by create-order on success.
function triggerRedirection(url) {
    const deepLinkUrl = toDeepLink(url);
    console.log("[Redirection] Opening deep link:", deepLinkUrl);
    try {
        window.location.href = deepLinkUrl;
    } catch (error) {
        console.warn("[Redirection] Failed to open deep link URL:", deepLinkUrl, error);
    }
}

export default function PNTOrderCreationPage() {
    const [amount, setAmount] = useState("100");
    const [remarks, setRemarks] = useState("New Payment order");
    const [response, setResponse] = useState("");
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        console.log("[PlatformCheck] navigator.platform:", navigator.platform, "->", detectNativePlatform());
    }, []);

    async function createOrder() {
        const webinitToken = await readWebInitToken();
        const partnerId = new URLSearchParams(window.location.search).get("partnerId") || "";

        if (!webinitToken) {
            window.alert("Please enter webinitToken");
            return;
        }

        if (!partnerId) {
            window.alert("Missing partnerId in the URL");
            return;
        }

        setLoading(true);

        const requestBody = {
            webinitToken,
            partnerId,
            partnerInvoiceId: buildPartnerInvoiceId(),
            partnerReferenceId: "REF20260522",
            currency: "MYR",
            amount: Number(amount),
            remark: remarks
        };

        try {
            const res = await fetch("/api/create-order", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody)
            });

            const data = await res.json();

            setResponse(JSON.stringify(data, null, 2));

            console.log("[Rajan] " + data + " -> " + res.status, data);
            try {
                if (data && data.success) {
                    const platform = detectNativePlatform();
                    console.log("[Rajan] Platform detected: " + platform);
                    const redirection = data.data && data.data.redirection;
                    console.log("[Rajan] redirection: " + redirection);
                    let redirectionUrl = "";
                    if (redirection) {
                        redirectionUrl = platform === "ios" ? redirection.ios : redirection.android;
                    }

                    console.log("[Rajan] redirectionUrl: " + redirectionUrl);

                    if (redirectionUrl) {
                        triggerRedirection(redirectionUrl);
                    } else {
                        console.warn("[Redirection] No redirection URL for platform:", platform);
                    }
                }
            } catch (error) {
                console.error("[Rajan] Error processing redirection:", error);
            }
        } catch (error) {
            setResponse(error.toString());
        } finally {
            setLoading(false);
        }
    }

    return (
        <>
            <title>Maybank Payment Test</title>
            <PageStyle css={css} />
            <h2> Payment Order </h2>

            <label htmlFor="amount">Amount</label>
            <input type="number" id="amount" value={amount} onChange={event => setAmount(event.target.value)} />

            <label htmlFor="remarks">Remarks</label>
            <input
                type="text"
                id="remarks"
                value={remarks}
                placeholder="Enter remarks"
                onChange={event => setRemarks(event.target.value)}
            />

            <button onClick={createOrder}>
                Create Payment Order
            </button>

            <h3>Response</h3>

            <pre id="response">{response}</pre>

            <div className={"loader-overlay" + (loading ? " visible" : "")} id="loaderOverlay">
                <div className="loader-spinner"></div>
            </div>
        </>
    );
}
