import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { PageStyle } from "../components/PageStyle";
import PaymentReceipt from "../components/PaymentReceipt";
import css from "../styles/payment-status.css?inline";

function getQueryParam(search, name) {
    const value = new URLSearchParams(search).get(name);
    if (!value || value === "null" || value === "undefined") {
        return "";
    }
    return value.trim();
}

// Deep link target: /paymentstatus?oid=MBB232 (or ?orderId=).
export default function PaymentStatusPage() {
    const { search } = useLocation();
    const [message, setMessage] = useState("Loading order details...");
    const [messageError, setMessageError] = useState(false);
    const [details, setDetails] = useState(null);

    useEffect(() => {
        let active = true;
        setMessage("Loading order details...");
        setMessageError(false);
        setDetails(null);

        const orderId = getQueryParam(search, "orderId") || getQueryParam(search, "oid");
        if (!orderId) {
            setMessage("An orderId is required to load payment details.");
            setMessageError(true);
            return;
        }
        const orderRefId = orderId.startsWith("MBB") ? orderId : "MBB" + orderId;

        (async () => {
            try {
                const response = await fetch("/api/local/orders/" + encodeURIComponent(orderRefId));
                const result = await response.json();
                if (!response.ok || !result.success) {
                    throw new Error(result.message || "Unable to load order details.");
                }
                const order = result.data;
                const createdAt = order.createdAt ? new Date(order.createdAt) : null;
                const hasDate = createdAt && Number.isFinite(createdAt.getTime());
                if (!active) return;
                setDetails({
                    orderRefId: order.orderRefId,
                    partnerReferenceId: order.partnerReferenceId,
                    partnerInvoiceId: order.partnerInvoiceId,
                    paymentStatus: order.paymentStatus,
                    amount: order.currency + " " + order.amount,
                    createdAt: hasDate ? createdAt.toISOString().slice(0, 10) : "",
                    createdAtDateTime: hasDate ? createdAt.toISOString() : undefined
                });
            } catch (error) {
                console.error("Unable to load payment details:", error);
                if (!active) return;
                setMessage(error.message);
                setMessageError(true);
            }
        })();
        return () => { active = false; };
    }, [search]);

    return (
        <>
            <title>Payment Status</title>
            <meta name="theme-color" content="#f4f6f8" />
            <PageStyle css={css} />
            <PaymentReceipt message={message} messageError={messageError} details={details} />
        </>
    );
}
