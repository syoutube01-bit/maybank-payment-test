(() => {
    // Renders the logged-in user's orders (keyed by the web-init JWT digitalID) into #myOrders.
    function formatDate(value) {
        const date = value ? new Date(value) : null;
        return date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
    }

    function renderOrders(list, orders) {
        const rows = document.createDocumentFragment();
        for (const order of orders) {
            const item = document.createElement("li");
            const link = document.createElement("a");
            link.className = "my-order";
            link.href = "/paymentstatus?orderId=" + encodeURIComponent(order.orderRefId);

            const id = document.createElement("span");
            id.className = "my-order-id";
            id.textContent = order.orderRefId;
            const status = document.createElement("span");
            status.className = "my-order-status";
            status.dataset.status = String(order.paymentStatus || "").toUpperCase();
            status.textContent = order.paymentStatus;
            const amount = document.createElement("span");
            amount.className = "my-order-amount";
            amount.textContent = (order.currency ? order.currency + " " : "") + order.amount;
            const date = document.createElement("time");
            date.className = "my-order-date";
            date.textContent = formatDate(order.createdAt);
            if (date.textContent) date.dateTime = date.textContent;

            link.append(id, status, amount, date);
            item.appendChild(link);
            rows.appendChild(item);
        }
        list.replaceChildren(rows);
    }

    async function loadMyOrders() {
        const section = document.getElementById("myOrders");
        if (!section) return;
        const message = section.querySelector(".my-orders-message");
        const list = section.querySelector(".my-orders-list");
        section.hidden = false;
        message.textContent = "Loading your orders...";
        list.replaceChildren();
        try {
            const webInitToken = await window.paymentSession.getWebInitToken();
            const res = await fetch("/api/my/orders", {
                method: "GET",
                headers: { "x-webinit-token": webInitToken }
            });
            const data = JSON.parse(await res.text());
            if (!res.ok || data?.success !== true || !Array.isArray(data.data)) {
                throw new Error(data?.message || "HTTP " + res.status);
            }
            renderOrders(list, data.data);
            message.textContent = data.data.length === 0 ? "You have no orders yet." : "";
            message.hidden = data.data.length !== 0;
        } catch (error) {
            message.hidden = false;
            message.textContent = "Unable to load your orders: " + error.message;
        }
    }

    window.myOrders = { load: loadMyOrders };
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", loadMyOrders);
    } else {
        loadMyOrders();
    }
})();
