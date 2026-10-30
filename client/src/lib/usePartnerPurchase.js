import { useRef, useState } from "react";
import { createPartnerOrder, getDpAccessToken } from "./payment";
import { usePaymentSession } from "./paymentSession";

// Shared Buy flow of the CTOS, Easybook and eSIM landing pages.
export function usePartnerPurchase(partnerId) {
    const paymentSession = usePaymentSession();
    const buyingRef = useRef(false);
    const [isBuying, setIsBuying] = useState(false);
    const [paymentStatus, setPaymentStatus] = useState("");

    async function buy({ amount, remark }) {
        if (buyingRef.current) return;
        buyingRef.current = true;
        setIsBuying(true);
        setPaymentStatus("Getting payment token...");
        try {
            const accessToken = await getDpAccessToken();
            setPaymentStatus("Creating order...");
            await createPartnerOrder(paymentSession, accessToken, { partnerId, amount, remark });
            setPaymentStatus("Redirecting to payment...");
        } catch (error) {
            setPaymentStatus("Payment failed: " + error.message);
        } finally {
            buyingRef.current = false;
            setIsBuying(false);
        }
    }

    return { paymentSession, isBuying, paymentStatus, buy };
}
