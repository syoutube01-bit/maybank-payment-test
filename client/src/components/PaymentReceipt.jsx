export const failedStatuses = ["FAIL", "FAILED", "REJECT", "REJECTED", "CANCEL", "CANCELLED", "CANCELED"];

export function paymentStatusClass(paymentStatus) {
    const normalizedStatus = String(paymentStatus || "").trim().toUpperCase();
    if (normalizedStatus === "SUCCESS") return "status-success";
    if (failedStatuses.includes(normalizedStatus)) return "status-error";
    return undefined;
}

// Shared payment receipt layout of the Payment Status and lookup Payment Status screens.
export default function PaymentReceipt({ message, messageError, details }) {
    return (
        <main className="status-shell">
            <div className="brand-row">
                <span className="brand-mark" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="M4 9h16M6 9v8m4-8v8m4-8v8m4-8v8M4 20h16M3 9l9-6 9 6" /></svg>
                </span>
                <span>Payment</span>
            </div>
            <section className="status-box" aria-labelledby="statusText">
                <p className="status-kicker">PAYMENT RECEIPT</p>
                <h1 className="status-text" id="statusText">Payment Status</h1>
                <p
                    className={"message" + (messageError ? " error" : "")}
                    id="message"
                    role="status"
                    aria-live="polite"
                    hidden={!!details}
                >{message}</p>
                <h2 className="details-heading" id="detailsHeading" hidden={!details}>Order details</h2>
                <dl className="order-details" id="orderDetails" aria-labelledby="detailsHeading" hidden={!details}>
                    <div className="detail-row"><dt>Order Reference Id</dt><dd id="orderRefId">{details?.orderRefId}</dd></div>
                    <div className="detail-row"><dt>Partner Reference Id</dt><dd id="partnerReferenceId">{details?.partnerReferenceId}</dd></div>
                    <div className="detail-row"><dt>Partner Invoice Id</dt><dd id="partnerInvoiceId">{details?.partnerInvoiceId}</dd></div>
                    <div className="detail-row"><dt>Amount</dt><dd id="amount">{details?.amount}</dd></div>
                    <div className="detail-row"><dt>Date</dt><dd><time id="createdAt" dateTime={details?.createdAtDateTime}>{details?.createdAt}</time></dd></div>
                    <div className="detail-row">
                        <dt>Payment Status</dt>
                        <dd id="paymentStatus" className={paymentStatusClass(details?.paymentStatus)}>{details?.paymentStatus}</dd>
                    </div>
                </dl>
            </section>
        </main>
    );
}
