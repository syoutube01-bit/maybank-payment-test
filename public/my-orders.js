(() => {
    // Renders the logged-in user's orders (keyed by the web-init JWT did) into #myOrders.
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
            id.textContent = "Order #" + order.orderRefId;
            const status = document.createElement("span");
            status.className = "my-order-status";
            status.dataset.status = String(order.paymentStatus || "").toUpperCase();
            status.textContent = order.paymentStatus;
            const amount = document.createElement("span");
            amount.className = "my-order-amount";
            const formattedAmount = Number(order.amount).toLocaleString("en-MY", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            });
            amount.textContent = (order.currency ? order.currency + " " : "") + formattedAmount;
            const date = document.createElement("time");
            date.className = "my-order-date";
            const createdDate = formatDate(order.createdAt);
            date.textContent = createdDate ? "Placed " + createdDate : "";
            if (createdDate) date.dateTime = createdDate;

            const action = document.createElement("span");
            action.className = "my-order-action";
            action.textContent = "View order details";
            link.append(id, status, amount, date, action);
            item.appendChild(link);
            rows.appendChild(item);
        }
        list.replaceChildren(rows);
    }

    let isLoading = false;
    let isLookingUp = false;
    let isPrompting = false;

    function promptLookup(message, defaultValue) {
        const dialog = document.getElementById("lookupDialog");
        const input = document.getElementById("lookupValue");
        document.getElementById("lookupLabel").textContent = message;
        input.value = defaultValue;
        dialog.returnValue = "";
        return new Promise(resolve => {
            document.getElementById("lookupForm").onsubmit = event => {
                event.preventDefault();
                if (input.value.trim()) dialog.close("confirm");
            };
            document.getElementById("lookupCancel").onclick = () => dialog.close();
            dialog.onclose = () => resolve(dialog.returnValue === "confirm" ? input.value.trim() : null);
            dialog.showModal();
            input.select();
        });
    }

    async function lookupOrder(endpoint, parameter, promptMessage, defaultValue) {
        if (isLookingUp || isLoading || isPrompting) return;
        isPrompting = true;
        let value;
        try {
            value = await promptLookup(promptMessage, defaultValue);
        } finally {
            isPrompting = false;
        }
        if (!value || !value.trim()) return;

        const section = document.getElementById("myOrders");
        const message = section.querySelector(".my-orders-message");
        const refreshButton = section.querySelector(".my-orders-refresh");
        const lookupButtons = [
            document.getElementById("lookupByOrderId"),
            document.getElementById("lookupByInvoiceId")
        ];
        isLookingUp = true;
        refreshButton.disabled = true;
        lookupButtons.forEach(button => { button.disabled = true; });
        message.dataset.loading = "true";
        message.hidden = false;
        message.textContent = "Looking up order...";
        try {
            const webInitToken = await window.paymentSession.getWebInitToken();
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
            window.sessionStorage.setItem("lookupPaymentStatus", JSON.stringify(order));
            window.location.assign("/lookup-payment-status.html");
            message.hidden = true;
        } catch (error) {
            message.textContent = "Lookup failed: " + error.message;
        } finally {
            delete message.dataset.loading;
            isLookingUp = false;
            refreshButton.disabled = false;
            lookupButtons.forEach(button => { button.disabled = false; });
        }
    }

    async function loadMyOrders() {
        const section = document.getElementById("myOrders");
        if (!section || isLoading || isLookingUp) return;
        const message = section.querySelector(".my-orders-message");
        const list = section.querySelector(".my-orders-list");
        const refreshButton = section.querySelector(".my-orders-refresh");
        isLoading = true;
        refreshButton.disabled = true;
        section.setAttribute("aria-busy", "true");
        section.hidden = false;
        message.hidden = false;
        message.textContent = "Loading your orders...";
        list.replaceChildren();
        try {
            const webInitToken = await window.paymentSession.getWebInitToken();
            const res = await fetch("/api/my/orders", {
                method: "GET",
                cache: "no-store",
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
        } finally {
            isLoading = false;
            refreshButton.disabled = false;
            section.setAttribute("aria-busy", "false");
        }
    }

    // Points the landing page "My orders" button at the dedicated screen for that partner,
    // keeping the current query string (e.g. MAE launch parameters).
    function initializeMyOrdersLink() {
        const link = document.getElementById("myOrdersLink");
        if (!link || !link.dataset.partnerId) return;
        const params = new URLSearchParams(window.location?.search || "");
        params.set("partnerId", link.dataset.partnerId);
        link.href = "/my-orders.html?" + params.toString();
    }

    function initializeMyOrders() {
        initializeMyOrdersLink();
        const refreshButton = document.querySelector("#myOrders .my-orders-refresh");
        const lookupByOrderId = document.getElementById("lookupByOrderId");
        const lookupByInvoiceId = document.getElementById("lookupByInvoiceId");
        if (refreshButton) refreshButton.addEventListener("click", loadMyOrders);
        if (lookupByOrderId) {
            lookupByOrderId.addEventListener("click", () =>
                lookupOrder("/api/dp/order-status", "orderRefId", "Enter Order Reference Id", "MBB393"));
        }
        if (lookupByInvoiceId) {
            lookupByInvoiceId.addEventListener("click", () =>
                lookupOrder("/api/dp/order-by-invoice", "partnerInvoiceId", "Enter Partner Invoice Id", "INV20260914212"));
        }
        return loadMyOrders();
    }

    window.myOrders = { load: loadMyOrders };
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initializeMyOrders);
    } else {
        initializeMyOrders();
    }
})();
