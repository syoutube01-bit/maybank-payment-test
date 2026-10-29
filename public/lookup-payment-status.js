(() => {
    const message = document.getElementById("message");
    try {
        const order = JSON.parse(window.sessionStorage.getItem("lookupPaymentStatus"));
        if (!order || typeof order !== "object" || Array.isArray(order) ||
            typeof (order.orderRefId ?? order.orderId) !== "string" ||
            !(order.orderRefId ?? order.orderId).trim()) {
            throw new Error("No lookup result available. Return to My Orders and look up an Order ID or Invoice ID.");
        }

        const fields = {
            orderRefId: order.orderRefId ?? order.orderId,
            partnerReferenceId: order.partnerReferenceId ?? order.ParnerRefNumber,
            partnerInvoiceId: order.partnerInvoiceId ?? order.PartnerInvoice,
            paymentStatus: order.paymentStatus ?? order.PaymentStatus
        };
        for (const [id, value] of Object.entries(fields)) {
            document.getElementById(id).textContent =
                typeof value === "string" && value.trim() ? value : "Not provided";
        }
        const paymentStatus = document.getElementById("paymentStatus");
        const normalizedStatus = String(fields.paymentStatus || "").trim().toUpperCase();
        if (normalizedStatus === "SUCCESS") {
            paymentStatus.classList.add("status-success");
        } else if (["FAIL", "FAILED", "REJECT", "REJECTED", "CANCEL", "CANCELLED", "CANCELED"].includes(normalizedStatus)) {
            paymentStatus.classList.add("status-error");
        }
        const amount = order.amount;
        const hasAmount = (typeof amount === "number" && Number.isFinite(amount)) ||
            (typeof amount === "string" && amount.trim() && Number.isFinite(Number(amount)));
        document.getElementById("amount").textContent = hasAmount
            ? (typeof order.currency === "string" && order.currency.trim() ? order.currency + " " : "") + amount
            : "Not provided";

        const createdAt = order.createdAt ? new Date(order.createdAt) : null;
        const dateElement = document.getElementById("createdAt");
        if (createdAt && Number.isFinite(createdAt.getTime())) {
            dateElement.dateTime = createdAt.toISOString();
            dateElement.textContent = createdAt.toISOString().slice(0, 10);
        } else {
            dateElement.textContent = "Not provided";
        }
        document.getElementById("orderDetails").hidden = false;
        document.getElementById("detailsHeading").hidden = false;
        message.hidden = true;
    } catch (error) {
        console.error("Unable to display lookup payment details:", error);
        message.textContent = error.message;
        message.classList.add("error");
    }
})();
