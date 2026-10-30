import { useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { PageStyle } from "../components/PageStyle";
import css from "../styles/api-test.css?inline";

const columns = [
    "orderRefId", "partnerReferenceId", "partnerInvoiceId", "currency",
    "amount", "createdAt", "paymentStatus", "orderStatus", "partnerCode",
    "partnerName", "PartnerInvoice", "ParnerRefNumber", "statusDescription",
    "completedDateTime", "PaymentStatusCode", "digitalId"
];

const headings = [
    "Order Reference Id", "Partner Reference Id", "Partner Invoice Id", "Currency",
    "Amount", "Created At", "Payment Status", "Order Status", "Partner Code",
    "Partner Name", "Partner Invoice", "Partner Reference Number", "Status Description",
    "Completed Date Time", "Payment Status Code", "dID"
];

export default function ApiTestPage() {
    const navigate = useNavigate();
    const { search } = useLocation();
    const dialogRef = useRef(null);
    const busyRef = useRef(false);
    const [busy, setBusy] = useState(false);
    const [resultsHidden, setResultsHidden] = useState(true);
    const [status, setStatus] = useState("");
    const [orders, setOrders] = useState([]);
    const [tableHidden, setTableHidden] = useState(true);

    function startRequest(message) {
        busyRef.current = true;
        setBusy(true);
        setResultsHidden(false);
        setStatus(message);
    }

    function finishRequest() {
        busyRef.current = false;
        setBusy(false);
    }

    async function getFromDb() {
        if (busyRef.current) return;
        startRequest("Loading saved orders...");
        setTableHidden(true);
        setOrders([]);
        try {
            const res = await fetch("/api/local/orders", { method: "GET" });
            const text = await res.text();
            if (!res.ok) {
                throw new Error("HTTP " + res.status + "\n" + text);
            }
            const data = JSON.parse(text);
            if (!data || data.success !== true || !Array.isArray(data.data)) {
                throw new Error("Invalid orders response");
            }
            setOrders(data.data);
            setTableHidden(data.data.length === 0);
            setStatus(data.data.length === 0
                ? "No saved orders found."
                : data.data.length + " saved order(s). Scroll horizontally or vertically to see all data.");
        } catch (error) {
            setStatus("Unable to load saved orders: " + error.message);
        } finally {
            finishRequest();
        }
    }

    async function clearDb() {
        if (busyRef.current) return;
        startRequest("Clearing saved orders...");
        try {
            const res = await fetch("/api/local/orders/clear", { method: "POST" });
            const text = await res.text();
            if (!res.ok) {
                throw new Error("HTTP " + res.status + "\n" + text);
            }
            const data = JSON.parse(text);
            if (!data || data.success !== true || !Number.isSafeInteger(data.deletedCount) || data.deletedCount < 0) {
                throw new Error("Invalid clear database response");
            }
            setOrders([]);
            setTableHidden(true);
            setStatus("Database cleared. " + data.deletedCount + " saved order(s) deleted.");
        } catch (error) {
            setStatus("Unable to clear saved orders: " + error.message);
        } finally {
            finishRequest();
        }
    }

    function openClearDialog() {
        if (busyRef.current) return;
        const dialog = dialogRef.current;
        if (!dialog.open) dialog.showModal();
    }

    function confirmClearDb() {
        const dialog = dialogRef.current;
        if (!dialog.open) return;
        dialog.close();
        return clearDb();
    }

    return (
        <>
            <title>Maybank Payment Test</title>
            <PageStyle css={css} />
            <h2>Select Payment Type</h2>
            <button id="dpBtn" onClick={() => navigate("/DPLandingScreen.html" + search)}>DP</button>
            <button id="pntBtn" onClick={() => navigate("/PNTOrderCreation.html" + search)}>PNT</button>
            <button id="getFromDbBtn" disabled={busy} onClick={getFromDb}>Get from DB</button>
            <button id="clearDbBtn" disabled={busy} onClick={openClearDialog}>Clear DB</button>
            <section className="db-results" id="dbResults" hidden={resultsHidden} aria-labelledby="dbHeading">
                <h3 id="dbHeading">Saved Orders</h3>
                <p id="dbStatus" role="status">{status}</p>
                <div className="table-scroll" tabIndex={0} role="region" aria-label="Saved orders table" hidden={tableHidden} id="dbTableContainer">
                    <table>
                        <caption>Orders stored in the local database (newest first)</caption>
                        <thead>
                            <tr>
                                {headings.map(heading => <th scope="col" key={heading}>{heading}</th>)}
                            </tr>
                        </thead>
                        <tbody id="dbOrdersBody">
                            {orders.map((order, index) => (
                                <tr key={index}>
                                    {columns.map(column => <td key={column}>{String(order[column] ?? "")}</td>)}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>
            <dialog id="clearDbDialog" ref={dialogRef} aria-labelledby="clearDbTitle" aria-describedby="clearDbWarning">
                <h3 id="clearDbTitle">Clear DB</h3>
                <p id="clearDbWarning">Clear all users saved orders from the database? This cannot be undone.</p>
                <form method="dialog" className="dialog-actions">
                    <button className="dialog-cancel">Cancel</button>
                    <button type="button" id="confirmClearDbBtn" onClick={confirmClearDb}>Clear DB</button>
                </form>
            </dialog>
        </>
    );
}
