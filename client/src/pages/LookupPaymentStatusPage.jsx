import { useEffect, useState } from "react";
import { PageStyle } from "../components/PageStyle";
import PaymentReceipt from "../components/PaymentReceipt";
import css from "../styles/payment-status.css?inline";

export const LOOKUP_STORAGE_KEY = "lookupPaymentStatus";

function displayText(value) {
    return typeof value === "string" && value.trim() ? value : "Not provided";
}

// Display-only receipt for the latest My Orders lookup, kept in this tab's session storage.
export function readLookupDetails() {
    const order = JSON.parse(window.sessionStorage.getItem(LOOKUP_STORAGE_KEY));
    if (!order || typeof order !== "object" || Array.isArray(order) ||
        typeof (order.orderRefId ?? order.orderId) !== "string" ||
        !(order.orderRefId ?? order.orderId).trim()) {
        throw new Error("No lookup result available. Return to My Orders and look up an Order ID or Invoice ID.");
    }

    const paymentStatus = order.paymentStatus ?? order.PaymentStatus;
    const amount = order.amount;
    const hasAmount = (typeof amount === "number" && Number.isFinite(amount)) ||
        (typeof amount === "string" && amount.trim() && Number.isFinite(Number(amount)));
    const createdAt = order.createdAt ? new Date(order.createdAt) : null;
    const hasDate = createdAt && Number.isFinite(createdAt.getTime());

    return {
        orderRefId: displayText(order.orderRefId ?? order.orderId),
        partnerReferenceId: displayText(order.partnerReferenceId ?? order.ParnerRefNumber),
        partnerInvoiceId: displayText(order.partnerInvoiceId ?? order.PartnerInvoice),
        paymentStatus: displayText(paymentStatus),
        amount: hasAmount
            ? (typeof order.currency === "string" && order.currency.trim() ? order.currency + " " : "") + amount
            : "Not provided",
        createdAt: hasDate ? createdAt.toISOString().slice(0, 10) : "Not provided",
        createdAtDateTime: hasDate ? createdAt.toISOString() : undefined
    };
}

export default function LookupPaymentStatusPage() {
    const [message, setMessage] = useState("Loading lookup details...");
    const [messageError, setMessageError] = useState(false);
    const [details, setDetails] = useState(null);

    useEffect(() => {
        try {
            setDetails(readLookupDetails());
        } catch (error) {
            console.error("Unable to display lookup payment details:", error);
            setMessage(error.message);
            setMessageError(true);
        }
    }, []);

    return (
        <>
            <title>Payment Status</title>
            <meta name="theme-color" content="#f4f6f8" />
            <PageStyle css={css} />
            <PaymentReceipt message={message} messageError={messageError} details={details} />
        </>
    );
}
