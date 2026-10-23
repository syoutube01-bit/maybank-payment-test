const express = require("express");
const axios = require("axios");
const path = require("path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { CompactSign, CompactEncrypt, compactDecrypt, compactVerify } = require("jose");
const { rateLimit } = require("express-rate-limit");

const app = express();
const databasePath = process.env.LOCAL_DB_PATH || path.join(__dirname, "data", "orders.sqlite");
let orderDatabase;

function getOrderDatabase() {
    if (!orderDatabase) {
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        orderDatabase = new DatabaseSync(databasePath);
        orderDatabase.exec(`
            CREATE TABLE IF NOT EXISTS orders (
                orderRefId TEXT PRIMARY KEY,
                partnerReferenceId TEXT NOT NULL,
                partnerInvoiceId TEXT NOT NULL,
                currency TEXT NOT NULL,
                amount INTEGER NOT NULL,
                createdAt TEXT NOT NULL,
                paymentStatus TEXT NOT NULL,
                orderStatus TEXT NOT NULL
            )
        `);
    }
    return orderDatabase;
}

const MAYBANK_API_BASE_URL = "https://payments-npas.maybank.com.my/sit/";
const MAYBANK_CREATE_ORDER_PATH = "payment-sdk/v1/orders";
const DP_ORDERS_URL = "https://staging.api.maybank.com/api/my/microsite/v1/orders";
const DP_VIEW_PARTY_URL = "https://staging.api.maybank.com/api/my/microsite/v1/view/party";
const DP_ORDER_STATUS_URL = "https://staging.api.maybank.com/api/my/microsite/v1/orders/status";
const DP_ORDER_BY_INVOICE_URL = "https://staging.api.maybank.com/api/my/microsite/v1/order/partner/invoice";
const DP_TOKEN_URL = "https://staging.api.maybank.com/api/oauth2/v8/clientcred/token";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function persistOrderResponse(responseData, requestPayload = {}) {
    let order = responseData;
    if (typeof order === "string") {
        order = JSON.parse(order);
    }
    if (!order || typeof order !== "object" || Array.isArray(order)) {
        throw new Error("Create order response must be a JSON object to save locally.");
    }

    const storedOrder = {
        orderRefId: order.orderRefId || order.orderId,
        partnerReferenceId: order.partnerReferenceId || requestPayload.partnerReferenceId,
        partnerInvoiceId: order.partnerInvoiceId || requestPayload.partnerInvoiceId,
        currency: order.currency || requestPayload.currency,
        amount: order.amount ?? requestPayload.amount,
        createdAt: order.createdAt || new Date().toISOString(),
        paymentStatus: order.paymentStatus || "PENDING",
        orderStatus: order.orderStatus || "CREATED"
    };
    if (typeof storedOrder.orderRefId !== "string" || !storedOrder.orderRefId ||
        typeof storedOrder.partnerReferenceId !== "string" || !storedOrder.partnerReferenceId ||
        typeof storedOrder.partnerInvoiceId !== "string" || !storedOrder.partnerInvoiceId ||
        typeof storedOrder.currency !== "string" || !storedOrder.currency ||
        !Number.isSafeInteger(storedOrder.amount) || storedOrder.amount <= 0) {
        throw new Error("Create order response is missing required order details for local storage.");
    }

    getOrderDatabase().prepare(`
        INSERT INTO orders (
            orderRefId, partnerReferenceId, partnerInvoiceId, currency, amount,
            createdAt, paymentStatus, orderStatus
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(orderRefId) DO UPDATE SET
            partnerReferenceId = excluded.partnerReferenceId,
            partnerInvoiceId = excluded.partnerInvoiceId,
            currency = excluded.currency,
            amount = excluded.amount,
            createdAt = excluded.createdAt,
            paymentStatus = excluded.paymentStatus,
            orderStatus = excluded.orderStatus
    `).run(
        storedOrder.orderRefId,
        storedOrder.partnerReferenceId,
        storedOrder.partnerInvoiceId,
        storedOrder.currency,
        storedOrder.amount,
        storedOrder.createdAt,
        storedOrder.paymentStatus,
        storedOrder.orderStatus
    );
}

const partnerLandingPages = {
    "mbb-mae-easybook": "easybook-landing.html",
    "mbb-mae-esim": "esim-landing.html",
    "mbb-mae-ctos": "ctos-landing.html"
};

app.get("/", (req, res, next) => {
    const landingPage = Object.hasOwn(partnerLandingPages, req.query.partnerId)
        ? partnerLandingPages[req.query.partnerId]
        : undefined;
    if (!landingPage) {
        return next();
    }

    const queryIndex = req.originalUrl.indexOf("?");
    const query = queryIndex === -1 ? "" : req.originalUrl.slice(queryIndex);
    return res.redirect(302, `/${landingPage}${query}`);
});

// Serve HTML
app.use(express.static(path.join(__dirname, "public")));

// Payment status screen (deep link target: /paymentstatus?oid=MBB232)
app.get("/paymentstatus", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "paymentstatus.html"));
});

app.get("/api/local/orders", (req, res) => {
    try {
        const orders = getOrderDatabase().prepare(`
            SELECT orderRefId, partnerReferenceId, partnerInvoiceId, currency, amount,
                createdAt, paymentStatus, orderStatus
            FROM orders
            ORDER BY createdAt DESC, orderRefId DESC
        `).all();
        return res.json({ success: true, data: orders });
    } catch (error) {
        console.error("Unable to read local orders:", error);
        return res.status(500).json({
            success: false,
            message: "Unable to load orders from the local database"
        });
    }
});

app.post("/api/local/orders/clear", (req, res) => {
    try {
        const result = getOrderDatabase().prepare("DELETE FROM orders").run();
        return res.json({ success: true, deletedCount: result.changes });
    } catch (error) {
        console.error("Unable to clear local orders:", error);
        return res.status(500).json({
            success: false,
            message: "Unable to clear orders from the local database"
        });
    }
});

// Create Maybank payment order
app.post("/api/create-order", async (req, res) => {
    try {
        const {
            webinitToken,
            partnerId,
            partnerInvoiceId,
            partnerReferenceId,
            currency,
            amount,
            remark
        } = req.body;

        if (!webinitToken) {
            return res.status(400).json({
                success: false,
                message: "webinitToken is required"
            });
        }

        if (!partnerId) {
            return res.status(400).json({
                success: false,
                message: "partnerId is required"
            });
        }

        const requestBody = {
            partnerInvoiceId,
            partnerReferenceId,
            currency,
            amount,
            remark
        };
        console.log("Create orderRequest Body:", requestBody);

        const requestHeaders = {
            "Content-Type": "application/json",
            "x-mb-client-id": partnerId,
            "x-mb-e2e-id": "346918df-af88-4b3a-95e3-273eebf30aea",
            "x-mb-env": "U",
            "x-mb-timestamp": Date.now().toString(),
            "dip-authorization": `bearer ${webinitToken}`
        };

        console.log("Maybank API Request Headers:", requestHeaders);
        
        const createOrderUrl = new URL(
            MAYBANK_CREATE_ORDER_PATH,
            MAYBANK_API_BASE_URL
        ).toString();

        console.log("Maybank API Request URL:", createOrderUrl);

        const response = await axios.post(
            createOrderUrl,
            requestBody,
            { headers: requestHeaders }
        );
console.log("Maybank API FULL Response :", response);
        console.log("Maybank API Response:", response.data);
        persistOrderResponse(response.data, requestBody);
        return res.status(response.status).json({
            success: true,
            data: response.data
        });

    } catch (error) {

        console.log("Rajan ERROR :", error);
        const maybankError = error.response?.data || error.message;
        console.error("Maybank API Error:", maybankError);
        console.error("Maybank API Request URL:", error.config?.url);

        if (error.response?.headers?.location) {
            console.error(
                "Maybank API Redirect Location:",
                error.response.headers.location
            );
        }

        return res.status(
            error.response?.status || 500
        ).json({
            success: false,
            message: "Unable to create payment order",
            error: error.response?.data || error.message
        });
    }
});

function buildDpE2eId() {
    return Array.from({ length: 16 }, (_, i) =>
        Math.floor(i === 0 ? 1 + Math.random() * 9 : Math.random() * 10)
    ).join("");
}

async function encryptDpBody(body) {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(
        process.env.DP_SIGNING_PRIVATE_KEY_PATH || path.join(__dirname, "private-keys", "dp-signing.pem"),
        "utf8"
    ));
    const publicKey = crypto.createPublicKey(fs.readFileSync(
        process.env.DP_ENCRYPTION_PUBLIC_KEY_PATH || path.join(__dirname, "private-keys", "dp-encryption-public.pem"),
        "utf8"
    ));
    const signedBody = await new CompactSign(Buffer.from(body, "utf8"))
        .setProtectedHeader({ alg: "RS256" })
        .sign(privateKey);
    return new CompactEncrypt(Buffer.from(signedBody, "utf8"))
        .setProtectedHeader({ alg: "RSA-OAEP-256", enc: "A256CBC-HS512", cty: "JWT" })
        .encrypt(publicKey);
}

async function decryptDpBody(body) {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(
        process.env.DP_SIGNING_PRIVATE_KEY_PATH || path.join(__dirname, "private-keys", "dp-signing.pem"),
        "utf8"
    ));
    const publicKey = crypto.createPublicKey(fs.readFileSync(
        process.env.DP_RESPONSE_VERIFICATION_PUBLIC_KEY_PATH || process.env.DP_ENCRYPTION_PUBLIC_KEY_PATH ||
            path.join(__dirname, "private-keys", "dp-encryption-public.pem"),
        "utf8"
    ));
    const decrypted = await compactDecrypt(body, privateKey, {
        keyManagementAlgorithms: ["RSA-OAEP-256"],
        contentEncryptionAlgorithms: ["A256CBC-HS512"]
    });
    const verified = await compactVerify(Buffer.from(decrypted.plaintext).toString("utf8"), publicKey, {
        algorithms: ["RS256"]
    });
    return JSON.stringify(JSON.parse(Buffer.from(verified.payload).toString("utf8")));
}

function signDpHeaders(method, url, headers, body = "") {
    const privateKey = fs.readFileSync(
        process.env.DP_SIGNING_PRIVATE_KEY_PATH || path.join(__dirname, "private-keys", "dp-signing.pem"),
        "utf8"
    );
    const signedHeaders = headers["X-MB-Signed-Headers"].split(";")
        .map(headerName => `${headerName}=${headers[headerName]}`).join(";");
    const signingString = `${method.toUpperCase()};${encodeURIComponent(url)};${signedHeaders};${body}`;
    return crypto.sign(
        "RSA-SHA256",
        Buffer.from(signingString, "utf8"),
        { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }
    ).toString("base64");
}

function buildDpHeaders(webinitToken, accessToken, {
    method, url, body, contentType = "text/plain", environment = "U",
    e2eId = crypto.randomBytes(16).toString("hex"), consumer
}) {
    const timestamp = Date.now().toString();
    const headers = {
        "Content-Type": contentType,
        "X-MB-Timestamp": timestamp,
        "X-MB-API-KEY": "mst-my-v1-1f238f6b08b446a6b590a69571127e78",
        "X-MB-E2E-Id": e2eId,
        "X-MB-Authorization": accessToken,
        "X-MB-Client-Id": "efb87ad528874d1b860d06d7867d11fd",
        "X-MB-ENV": environment,
        "X-MB-Signature-Alg": "RSA-SHA256",
        "X-MB-Signed-Headers": "X-MB-Client-Id;X-MB-Authorization;X-MB-Timestamp",
        "X-MB-Signature-Value": ""
    };
    if (webinitToken) headers["dip-authorization"] = `bearer ${webinitToken}`;
    if (consumer) headers["X-Consumer"] = consumer;
    headers["X-MB-Signature-Value"] = signDpHeaders(method, url, headers, body);
    return headers;
}

function dpRateLimiter() {
    return rateLimit({
        windowMs: 1000, limit: 10, keyGenerator: () => "dp-service",
        standardHeaders: true, legacyHeaders: false
    });
}

function requireDpAccessToken(req, res, next) {
    if (!(req.get("x-access-token") || "").trim()) {
        return res.status(401).send("access_token is required. Get Token before calling this API.");
    }
    next();
}

function validateDpOrder(payload) {
    for (const [field, maxLength] of [["partnerReferenceId", 29], ["partnerInvoiceId", 14]]) {
        if (typeof payload[field] !== "string" || !payload[field].trim() || payload[field].length > maxLength) {
            return `${field} must be a non-empty string of at most ${maxLength} characters.`;
        }
    }
    if (typeof payload.currency !== "string" || !/^[A-Z]{3}$/.test(payload.currency)) {
        return "currency must be a three-letter uppercase currency code.";
    }
    if (!Number.isSafeInteger(payload.amount) || payload.amount <= 0) {
        return "amount must be a positive integer in cents.";
    }
    if (payload.remark !== undefined && (typeof payload.remark !== "string" || payload.remark.length > 60)) {
        return "remark must be a string of at most 60 characters.";
    }
    if (payload.fulfillment !== undefined) {
        const fulfillment = payload.fulfillment;
        if (!fulfillment || typeof fulfillment !== "object" || Array.isArray(fulfillment) ||
            typeof fulfillment.productType !== "string" || !fulfillment.productType.trim() ||
            !fulfillment.instructions || typeof fulfillment.instructions !== "object" || Array.isArray(fulfillment.instructions)) {
            return "fulfillment must contain productType and an instructions object.";
        }
    }
    return "";
}

function sendDpResponse(res, response) {
    for (const headerName of ["x-mb-e2e-id", "x-mb-elapsedtime", "x-mb-api-statuscode", "x-mb-api-statusdesc"]) {
        if (response.headers?.[headerName] !== undefined) res.set(headerName, response.headers[headerName]);
    }
    return res.status(response.status).type("text/plain").send(response.data);
}

function sendDpError(res, label, error) {
    console.error(`[${label}] ERROR:`, error.response?.data || error.message);
    return res.status(error.response?.status || error.statusCode || 500).send(
        error.response?.data || error.message
    );
}

// Sends a DP request and logs url, headers, body, response and error.
async function dpRequest(label, method, url, webinitToken, {
    params, body, signingBody, accessToken = "", headers: customHeaders, headerOptions = {}
} = {}) {
    const fullUrl = axios.getUri({ url, params });
    const requestBody = body === undefined || typeof body === "string" ? body : JSON.stringify(body);
    const headers = customHeaders || buildDpHeaders(webinitToken, accessToken,
        { ...headerOptions, method, url: fullUrl, body: signingBody === undefined ? requestBody : signingBody });
    console.log(`[${label}] Request URL: ${method.toUpperCase()} ${fullUrl}`);
    console.log(`[${label}] Request Headers:`, headers);
    console.log(`[${label}] Request Body:`, requestBody === undefined ? "(none)" : requestBody);

    const response = await axios.request({
        method,
        url,
        params,
        data: requestBody,
        headers,
        timeout: customHeaders ? 0 : 10000,
        ...(customHeaders ? {} : { validateStatus: () => true }),
        transformRequest: (data) => data,
        responseType: "text",
        transformResponse: (d) => d
    });
    console.log(`[${label}] Response Status:`, response.status);
    console.log(`[${label}] Response Body:`, response.data);
    if (!customHeaders && (response.status < 400 ||
        (typeof response.data === "string" && response.data.trim().split(".").length === 5))) {
        try {
            response.data = await decryptDpBody(response.data);
        } catch (error) {
            console.error(`[${label}] Response protection error:`, error.message);
            const protectionError = new Error("Unable to decrypt or verify Maybank response.");
            protectionError.statusCode = 502;
            throw protectionError;
        }
    }
    return response;
}

// DP create order: proxied server-side to avoid browser CORS
app.post("/api/dp/create-order", dpRateLimiter(), requireDpAccessToken,
    express.text({ type: "*/*", limit: "1mb" }), async (req, res) => {
    const accessToken = req.get("x-access-token");
    let orderPayload;
    try {
        orderPayload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch (error) {
        return res.status(400).send("Create Order body must be a valid JSON object.");
    }
    if (!orderPayload || typeof orderPayload !== "object" || Array.isArray(orderPayload)) {
        return res.status(400).send("Create Order body must be a valid JSON object.");
    }
    const validationError = validateDpOrder(orderPayload);
    if (validationError) return res.status(400).send(validationError);
    try {
        const webinitToken = (req.get("x-webinit-token") || "").trim();
        if (!webinitToken.trim()) {
            return res.status(400).send("webinitToken is required for Create Order.");
        }
        const plaintextBody = JSON.stringify(orderPayload);
        const encryptedBody = await encryptDpBody(plaintextBody);
        const response = await dpRequest("DP create order", "post", DP_ORDERS_URL,
            webinitToken, {
                body: encryptedBody,
                accessToken
            });
        persistOrderResponse(response.data, orderPayload);
        return sendDpResponse(res, response);
    } catch (error) {
        return sendDpError(res, "DP create order", error);
    }
});

// DP view party
app.get("/api/dp/view-party", dpRateLimiter(), requireDpAccessToken, async (req, res) => {
    try {
        const response = await dpRequest("DP view party", "get", DP_VIEW_PARTY_URL,
            req.get("x-webinit-token") || "", {
                params: { RequestedFields: "all" },
                accessToken: req.get("x-access-token"),
                headerOptions: { consumer: "Partner" }
            });
        return sendDpResponse(res, response);
    } catch (error) {
        return sendDpError(res, "DP view party", error);
    }
});

// DP order status by order reference id
app.get("/api/dp/order-status", dpRateLimiter(), requireDpAccessToken, async (req, res) => {
    const orderRefId = req.query.orderRefId;
    if (typeof orderRefId !== "string" || !orderRefId) {
        return res.status(400).send("orderRefId is required");
    }
    try {
        const response = await dpRequest("DP order status", "get", DP_ORDER_STATUS_URL,
            req.get("x-webinit-token") || "", { params: { orderRefId }, accessToken: req.get("x-access-token") });
        return sendDpResponse(res, response);
    } catch (error) {
        return sendDpError(res, "DP order status", error);
    }
});

// DP order lookup by partner invoice id
app.get("/api/dp/order-by-invoice", dpRateLimiter(), requireDpAccessToken, async (req, res) => {
    const partnerInvoiceId = req.query.partnerInvoiceId ?? req.query.invoiceId;
    if (typeof partnerInvoiceId !== "string" || !partnerInvoiceId) {
        return res.status(400).send("partnerInvoiceId is required");
    }
    try {
        const response = await dpRequest("DP order by invoice", "get", DP_ORDER_BY_INVOICE_URL,
            req.get("x-webinit-token") || "", { params: { partnerInvoiceId }, accessToken: req.get("x-access-token") });
        return sendDpResponse(res, response);
    } catch (error) {
        return sendDpError(res, "DP order by invoice", error);
    }
});

// DP client-credentials token
app.post("/api/dp/token", async (req, res) => {
    const timestamp = Date.now().toString();
    const headers = {
        "Content-Type": "application/json",
        "X-MB-Timestamp": timestamp,
        "X-MB-E2E-Id": buildDpE2eId(),
        "X-MB-ENV": "U",
        "X-MB-Signature-Alg": "RSA-SHA256",
        "X-MB-Signed-Headers": "X-MB-Timestamp",
        "X-MB-Signature-Value": ""
    };
    const body = JSON.stringify({
        grant_type: "client_credentials",
        scope: "microsite",
        client_id: "efb87ad528874d1b860d06d7867d11fd",
        client_secret: "cb7116e093784ab0b45bc4c6d1e4a2b7"
    });
    try {
        headers["X-MB-Signature-Value"] = signDpHeaders("POST", DP_TOKEN_URL, headers, body);
        const response = await dpRequest("DP token", "post", DP_TOKEN_URL, "", { body, headers });
        return res.status(response.status).send(response.data);
    } catch (error) {
        return sendDpError(res, "DP token", error);
    }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", (error) => {
    if (error) {
        console.error(`Unable to start server on port ${PORT}: ${error.message}`);
        process.exitCode = 1;
        return;
    }
    console.log(`Server running on port ${PORT}`);
});