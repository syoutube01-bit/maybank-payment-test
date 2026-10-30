import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router";
import { PageStyle, useBodyClass } from "../components/PageStyle";
import { usePaymentSession } from "../lib/paymentSession";
import { LOOKUP_STORAGE_KEY } from "./LookupPaymentStatusPage";
import css from "../styles/my-orders.css?inline";

const partnerNames = {
    "mbb-mae-ctos": "CTOS",
    "mbb-mae-easybook": "Easybook",
    "mbb-mae-esim": "eSIM"
};

function formatDate(value) {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}

function OrderCard({ order }) {
    const formattedAmount = Number(order.amount).toLocaleString("en-MY", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
    const createdDate = formatDate(order.createdAt);
    return (
        <li>
            <Link className="my-order" to={"/paymentstatus?orderId=" + encodeURIComponent(order.orderRefId)}>
                <span className="my-order-id">{"Order #" + order.orderRefId}</span>
                <span className="my-order-status" data-status={String(order.paymentStatus || "").toUpperCase()}>
                    {order.paymentStatus}
                </span>
                <span className="my-order-amount">{(order.currency ? order.currency + " " : "") + formattedAmount}</span>
                <time className="my-order-date" dateTime={createdDate || undefined}>
                    {createdDate ? "Placed " + createdDate : ""}
                </time>
                <span className="my-order-action">View order details</span>
            </Link>
        </li>
    );
}

export default function MyOrdersPage() {
    useBodyClass("orders-page");
    const navigate = useNavigate();
    const { search } = useLocation();
    const paymentSession = usePaymentSession();
    const partnerId = new URLSearchParams(search).get("partnerId") || "";
    const partnerName = Object.hasOwn(partnerNames, partnerId) ? partnerNames[partnerId] : "";

    const loadingRef = useRef(false);
    const lookingUpRef = useRef(false);
    const promptingRef = useRef(false);
    const initializedRef = useRef(false);
    const dialogRef = useRef(null);
    const inputRef = useRef(null);
    const resolveLookupRef = useRef(null);

    const [sectionHidden, setSectionHidden] = useState(true);
    const [isLoading, setIsLoading] = useState(false);
    const [isLookingUp, setIsLookingUp] = useState(false);
    const [orders, setOrders] = useState([]);
    const [message, setMessage] = useState("");
    const [messageHidden, setMessageHidden] = useState(false);
    const [lookupLabel, setLookupLabel] = useState("");
    const [lookupValue, setLookupValue] = useState("");

    async function loadMyOrders() {
        if (loadingRef.current || lookingUpRef.current) return;
        loadingRef.current = true;
        setIsLoading(true);
        setSectionHidden(false);
        setMessageHidden(false);
        setMessage("Loading your orders...");
        setOrders([]);
        try {
            const webInitToken = await paymentSession.getWebInitToken();
            const res = await fetch("/api/my/orders", {
                method: "GET",
                cache: "no-store",
                headers: { "x-webinit-token": webInitToken }
            });
            const data = JSON.parse(await res.text());
            if (!res.ok || data?.success !== true || !Array.isArray(data.data)) {
                throw new Error(data?.message || "HTTP " + res.status);
            }
            setOrders(data.data);
            setMessage(data.data.length === 0 ? "You have no orders yet." : "");
            setMessageHidden(data.data.length !== 0);
        } catch (error) {
            setMessageHidden(false);
            setMessage("Unable to load your orders: " + error.message);
        } finally {
            loadingRef.current = false;
            setIsLoading(false);
        }
    }

    useEffect(() => {
        if (initializedRef.current) return;
        initializedRef.current = true;
        loadMyOrders();
    });

    function promptLookup(label, defaultValue) {
        flushSync(() => {
            setLookupLabel(label);
            setLookupValue(defaultValue);
        });
        const dialog = dialogRef.current;
        dialog.returnValue = "";
        return new Promise(resolve => {
            resolveLookupRef.current = resolve;
            dialog.showModal();
            inputRef.current.focus();
            inputRef.current.select();
        });
    }

    function onLookupSubmit(event) {
        event.preventDefault();
        if (inputRef.current.value.trim()) dialogRef.current.close("confirm");
    }

    function onLookupClose() {
        const resolve = resolveLookupRef.current;
        resolveLookupRef.current = null;
        resolve?.(dialogRef.current.returnValue === "confirm" ? inputRef.current.value.trim() : null);
    }

    async function lookupOrder(endpoint, parameter, promptMessage, defaultValue) {
        if (lookingUpRef.current || loadingRef.current || promptingRef.current) return;
        promptingRef.current = true;
        let value;
        try {
            value = await promptLookup(promptMessage, defaultValue);
        } finally {
            promptingRef.current = false;
        }
        if (!value || !value.trim()) return;

        lookingUpRef.current = true;
        setIsLookingUp(true);
        setMessageHidden(false);
        setMessage("Looking up order...");
        try {
            const webInitToken = await paymentSession.getWebInitToken();
            const tokenResponse = await fetch("/api/dp/token", { method: "POST" });
            const tokenText = await tokenResponse.text();
            if (!tokenResponse.ok) {
                throw new Error("Get Token: HTTP " + tokenResponse.status + "\n" + tokenText);
            }
            const tokenData = JSON.parse(tokenText);
            const accessToken = tokenData?.responseData?.access_token;
            if (tokenData?.txnStatus?.code !== "AOK200" || typeof accessToken !== "string" || !accessToken.trim()) {
                throw new Error("Get Token returned no valid access token: " + tokenText);
            }

            const query = parameter + "=" + encodeURIComponent(value.trim());
            const res = await fetch(endpoint + "?" + query, {
                method: "GET",
                headers: { "x-webinit-token": webInitToken, "x-access-token": accessToken }
            });
            const responseText = await res.text();
            if (!res.ok) {
                throw new Error("HTTP " + res.status + "\n" + responseText);
            }
            const result = JSON.parse(responseText);
            const order = result?.order ?? result?.responseData ?? result?.data ?? result;
            if (result?.success === false ||
                (result?.statusCode != null && result.statusCode !== "0000") ||
                (result?.txnStatus?.code != null && result.txnStatus.code !== "AOK200")) {
                throw new Error(result.message || result.txnStatus?.message || responseText);
            }
            if (!order || typeof order !== "object" || Array.isArray(order) ||
                typeof (order.orderRefId ?? order.orderId) !== "string" ||
                !(order.orderRefId ?? order.orderId).trim()) {
                throw new Error("Lookup returned no valid order details.");
            }
            window.sessionStorage.setItem(LOOKUP_STORAGE_KEY, JSON.stringify(order));
            navigate("/lookup-payment-status.html");
            setMessageHidden(true);
        } catch (error) {
            setMessage("Lookup failed: " + error.message);
        } finally {
            lookingUpRef.current = false;
            setIsLookingUp(false);
        }
    }

    return (
        <>
            <title>{partnerName ? partnerName + " | My Orders" : "My Orders"}</title>
            <PageStyle css={css} />
            <main className="page">
                <header className="page-header">
                    <p className="partner-name" id="partnerName">{partnerName}</p>
                </header>
                <section
                    className="my-orders"
                    id="myOrders"
                    aria-labelledby="myOrdersHeading"
                    aria-busy={sectionHidden ? undefined : String(isLoading)}
                    hidden={sectionHidden}
                >
                    <div className="my-orders-header">
                        <div className="my-orders-heading">
                            <p className="eyebrow">ORDER ACTIVITY</p>
                            <h1 id="myOrdersHeading">My Orders</h1>
                            <p className="my-orders-description">View and manage your recent payments in one place.</p>
                        </div>
                        <button
                            className="my-orders-refresh"
                            type="button"
                            aria-label="Refresh my orders"
                            title="Refresh my orders"
                            disabled={isLoading || isLookingUp}
                            onClick={loadMyOrders}
                        >
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                                <path d="M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9"/>
                            </svg>
                        </button>
                    </div>
                    <div className="my-orders-lookups" aria-label="Look up an order">
                        <button
                            className="my-orders-lookup"
                            id="lookupByOrderId"
                            type="button"
                            disabled={isLookingUp}
                            onClick={() => lookupOrder("/api/dp/order-status", "orderRefId", "Enter Order Reference Id", "MBB393")}
                        >Order ID</button>
                        <button
                            className="my-orders-lookup"
                            id="lookupByInvoiceId"
                            type="button"
                            disabled={isLookingUp}
                            onClick={() => lookupOrder("/api/dp/order-by-invoice", "partnerInvoiceId", "Enter Partner Invoice Id", "INV20260914212")}
                        >Invoice ID</button>
                    </div>
                    <p
                        className="my-orders-message"
                        role="status"
                        aria-live="polite"
                        data-loading={isLookingUp ? "true" : undefined}
                        hidden={messageHidden}
                    >{message}</p>
                    <ul className="my-orders-list">
                        {orders.map((order, index) => <OrderCard key={order.orderRefId ?? index} order={order} />)}
                    </ul>
                </section>
            </main>
            <dialog className="lookup-dialog" id="lookupDialog" ref={dialogRef} aria-labelledby="lookupLabel" onClose={onLookupClose}>
                <form id="lookupForm" onSubmit={onLookupSubmit}>
                    <label id="lookupLabel" htmlFor="lookupValue">{lookupLabel}</label>
                    <input
                        id="lookupValue"
                        name="lookupValue"
                        ref={inputRef}
                        type="text"
                        autoComplete="off"
                        required
                        value={lookupValue}
                        onChange={event => setLookupValue(event.target.value)}
                    />
                    <div className="lookup-dialog-actions">
                        <button id="lookupCancel" type="button" onClick={() => dialogRef.current.close()}>Cancel</button>
                        <button type="submit">OK</button>
                    </div>
                </form>
            </dialog>
        </>
    );
}
