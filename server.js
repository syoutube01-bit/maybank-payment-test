const express = require("express");
const axios = require("axios");
const path = require("path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");
const { Pool } = require("pg");
const { CompactSign, CompactEncrypt, compactDecrypt, compactVerify } = require("jose");
const { rateLimit } = require("express-rate-limit");

const app = express();
const orderColumns = [
    "order_ref_id", "partner_reference_id", "partner_invoice_id", "currency", "amount",
    "created_at", "payment_status", "order_status", "partner_code", "partner_name",
    "partner_invoice", "parner_ref_number", "status_description", "completed_date_time",
    "payment_status_code", "digital_id"
];
const orderFieldNames = {
    order_ref_id: "orderRefId",
    partner_reference_id: "partnerReferenceId",
    partner_invoice_id: "partnerInvoiceId",
    created_at: "createdAt",
    payment_status: "paymentStatus",
    order_status: "orderStatus",
    partner_code: "partnerCode",
    partner_name: "partnerName",
    partner_invoice: "PartnerInvoice",
    parner_ref_number: "ParnerRefNumber",
    status_description: "statusDescription",
    completed_date_time: "completedDateTime",
    payment_status_code: "PaymentStatusCode",
    digital_id: "digitalId"
};
let schemaInitialization;
const postgresPool = process.env.DATABASE_URL
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ...(process.env.PGSSL === "true" ? { ssl: { rejectUnauthorized: false } } : {})
    })
    : null;

async function initializePostgresSchema() {
    if (!schemaInitialization) {
        schemaInitialization = postgresPool.query(`
            CREATE TABLE IF NOT EXISTS orders (
                order_ref_id TEXT PRIMARY KEY,
                partner_reference_id TEXT NOT NULL,
                partner_invoice_id TEXT NOT NULL,
                currency TEXT NOT NULL,
                amount DOUBLE PRECISION NOT NULL,
                created_at TEXT NOT NULL,
                payment_status TEXT NOT NULL,
                order_status TEXT NOT NULL,
                partner_code TEXT,
                partner_name TEXT,
                partner_invoice TEXT,
                parner_ref_number TEXT,
                status_description TEXT,
                completed_date_time TEXT,
                payment_status_code TEXT,
                digital_id TEXT,
                partner_id TEXT
            );
            ALTER TABLE orders ADD COLUMN IF NOT EXISTS partner_id TEXT;
            ALTER TABLE orders ALTER COLUMN amount TYPE DOUBLE PRECISION;
            CREATE INDEX IF NOT EXISTS idx_orders_digital_id
                ON orders (digital_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_orders_digital_id_partner_id
                ON orders (digital_id, partner_id, created_at)
        `).catch(error => {
            schemaInitialization = null;
            throw error;
        });
    }
    await schemaInitialization;
}

async function queryOrderDatabase(sql, parameters = []) {
    if (!postgresPool) {
        throw new Error("DATABASE_URL must be set to use the PostgreSQL database.");
    }
    await initializePostgresSchema();
    let index = 0;
    const postgresSql = sql.replace(/\?/g, () => `$${++index}`);
    const result = await postgresPool.query(postgresSql, parameters);
    return { rows: result.rows, rowCount: result.rowCount };
}

function mapOrderFields(order) {
    return Object.fromEntries(Object.entries(order).map(([column, value]) => [
        orderFieldNames[column] || column,
        value
    ]));
}

// Decodes (without verifying the signature) the did claim from the MAE web-init JWT.
// Throws when the token is malformed, expired or has no did.
function getDigitalIdFromWebInitToken(webinitToken) {
    const token = typeof webinitToken === "string"
        ? webinitToken.trim().replace(/^bearer\s+/i, "")
        : "";
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some(part => !part)) {
        throw new Error("Web-init token is not a signed JWT.");
    }
    let claims;
    try {
        claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
        throw new Error("Web-init JWT payload is not valid JSON.");
    }
    console.log("Rajan: Web-init JWT claims:", claims);
    if (typeof claims?.exp === "number" && claims.exp * 1000 <= Date.now()) {
        throw new Error("Web-init JWT has expired.");
    }
    if (typeof claims?.did !== "string" || !claims.did.trim()) {
        throw new Error("Web-init JWT has no valid did claim.");
    }
    const digitalId = claims.did.trim();
    return digitalId;
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

async function persistOrderResponse(responseData, requestPayload = {}, digitalId = null, partnerId = null) {
    let order = responseData;
    if (typeof order === "string") {
        order = JSON.parse(order);
    }
    if (!order || typeof order !== "object" || Array.isArray(order)) {
        throw new Error("Create order response must be a JSON object to save locally.");
    }

    const storedOrder = {
        orderRefId: order.orderRefId || order.orderId,
        partnerReferenceId: order.partnerReferenceId || order.ParnerRefNumber ||
            requestPayload.partnerReferenceId || requestPayload.ParnerRefNumber,
        partnerInvoiceId: order.partnerInvoiceId || order.PartnerInvoice ||
            requestPayload.partnerInvoiceId || requestPayload.PartnerInvoice,
        currency: order.currency || requestPayload.currency,
        amount: order.amount ?? requestPayload.amount,
        createdAt: order.createdAt || new Date().toISOString(),
        paymentStatus: order.paymentStatus || order.PaymentStatus || "PENDING",
        orderStatus: order.orderStatus || "CREATED",
        partnerCode: order.partnerCode ?? requestPayload.partnerCode ?? null,
        partnerName: order.partnerName ?? requestPayload.partnerName ?? null,
        PartnerInvoice: order.PartnerInvoice || order.partnerInvoiceId ||
            requestPayload.PartnerInvoice || requestPayload.partnerInvoiceId || null,
        ParnerRefNumber: order.ParnerRefNumber || order.partnerReferenceId ||
            requestPayload.ParnerRefNumber || requestPayload.partnerReferenceId || null,
        statusDescription: order.statusDescription ?? requestPayload.statusDescription ?? null,
        completedDateTime: order.completedDateTime ?? requestPayload.completedDateTime ?? null,
        PaymentStatusCode: order.PaymentStatusCode ?? requestPayload.PaymentStatusCode ?? null
    };
    if (typeof storedOrder.amount === "string" && /^\d+(?:\.\d+)?$/.test(storedOrder.amount)) {
        storedOrder.amount = Number(storedOrder.amount);
    }
    if (typeof storedOrder.orderRefId !== "string" || !storedOrder.orderRefId ||
        typeof storedOrder.partnerReferenceId !== "string" || !storedOrder.partnerReferenceId ||
        typeof storedOrder.partnerInvoiceId !== "string" || !storedOrder.partnerInvoiceId ||
        typeof storedOrder.currency !== "string" || !storedOrder.currency ||
        typeof storedOrder.amount !== "number" || !Number.isFinite(storedOrder.amount) || storedOrder.amount <= 0) {
        throw new Error("Create order response is missing required order details for local storage.");
    }

    await queryOrderDatabase(`
        INSERT INTO orders (
            order_ref_id, partner_reference_id, partner_invoice_id, currency, amount,
            created_at, payment_status, order_status, partner_code, partner_name,
            partner_invoice, parner_ref_number, status_description, completed_date_time,
            payment_status_code, digital_id, partner_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(order_ref_id) DO UPDATE SET
            digital_id = COALESCE(excluded.digital_id, orders.digital_id),
            partner_id = COALESCE(excluded.partner_id, orders.partner_id),
            partner_reference_id = excluded.partner_reference_id,
            partner_invoice_id = excluded.partner_invoice_id,
            currency = excluded.currency,
            amount = excluded.amount,
            created_at = excluded.created_at,
            payment_status = excluded.payment_status,
            order_status = excluded.order_status,
            partner_code = excluded.partner_code,
            partner_name = excluded.partner_name,
            partner_invoice = excluded.partner_invoice,
            parner_ref_number = excluded.parner_ref_number,
            status_description = excluded.status_description,
            completed_date_time = excluded.completed_date_time,
            payment_status_code = excluded.payment_status_code
    `, [
        storedOrder.orderRefId,
        storedOrder.partnerReferenceId,
        storedOrder.partnerInvoiceId,
        storedOrder.currency,
        storedOrder.amount,
        storedOrder.createdAt,
        storedOrder.paymentStatus,
        storedOrder.orderStatus,
        storedOrder.partnerCode,
        storedOrder.partnerName,
        storedOrder.PartnerInvoice,
        storedOrder.ParnerRefNumber,
        storedOrder.statusDescription,
        storedOrder.completedDateTime,
        storedOrder.PaymentStatusCode,
        digitalId,
        partnerId
    ]);
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

app.get("/api/local/orders", async (req, res) => {
    try {
        const { rows } = await queryOrderDatabase(`
            SELECT ${orderColumns.join(", ")}
            FROM orders
            ORDER BY created_at DESC, order_ref_id DESC
        `);
        return res.json({ success: true, data: rows.map(mapOrderFields) });
    } catch (error) {
        console.error("Unable to read orders from PostgreSQL:", error);
        return res.status(500).json({
            success: false,
            message: "Unable to load orders from PostgreSQL"
        });
    }
});

app.get("/api/local/orders/:orderRefId", async (req, res) => {
    try {
        const { rows } = await queryOrderDatabase(`
            SELECT ${orderColumns.filter(column => column !== "digital_id").join(", ")}
            FROM orders WHERE order_ref_id = ?
        `, [req.params.orderRefId]);
        const order = rows[0];
        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        return res.json({ success: true, data: mapOrderFields(order) });
    } catch (error) {
        console.error("Unable to read order from PostgreSQL:", error);
        return res.status(500).json({
            success: false,
            message: "Unable to load order from PostgreSQL"
        });
    }
});

// Orders of the logged-in microsite user, identified by did in the web-init JWT.
app.get("/api/my/orders", async (req, res) => {
    let digitalId;
    try {
        digitalId = getDigitalIdFromWebInitToken(req.get("x-webinit-token"));
    } catch (error) {
        return res.status(401).json({ success: false, message: error.message });
    }
    // Optional landing page filter, e.g. ?partnerId=mbb-mae-ctos.
    const partnerId = req.query?.partnerId;
    if (partnerId !== undefined && !Object.hasOwn(partnerLandingPages, partnerId)) {
        return res.status(400).json({ success: false, message: "Unknown partnerId." });
    }
    try {
        const { rows } = await queryOrderDatabase(`
            SELECT order_ref_id, payment_status, amount, currency, created_at,
                partner_name, partner_invoice_id
            FROM orders WHERE digital_id = ?${partnerId ? " AND partner_id = ?" : ""}
            ORDER BY created_at DESC, order_ref_id DESC
        `, partnerId ? [digitalId, partnerId] : [digitalId]);
        return res.json({ success: true, data: rows.map(mapOrderFields) });
    } catch (error) {
        console.error("Unable to read user orders:", error);
        return res.status(500).json({
            success: false,
            message: "Unable to load your orders"
        });
    }
});

app.post("/api/local/orders/payment-status", async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return res.status(400).json({
            success: false,
            message: "Request body must be a JSON object"
        });
    }
    const { orderRefId } = body;
    const paymentStatus = body.paymentStatus ?? body.PaymentStatus;
    if (typeof orderRefId !== "string" || !orderRefId.trim()) {
        return res.status(400).json({
            success: false,
            message: "orderRefId must be a non-empty string"
        });
    }
    if (typeof paymentStatus !== "string" || !paymentStatus.trim()) {
        return res.status(400).json({
            success: false,
            message: "paymentStatus must be a non-empty string"
        });
    }

    const optionalStrings = {
        partnerCode: body.partnerCode,
        partnerName: body.partnerName,
        PartnerInvoice: body.PartnerInvoice ?? body.partnerInvoiceId,
        ParnerRefNumber: body.ParnerRefNumber ?? body.partnerReferenceId,
        currency: body.currency,
        createdAt: body.createdAt,
        statusDescription: body.statusDescription,
        completedDateTime: body.completedDateTime,
        PaymentStatusCode: body.PaymentStatusCode,
        orderStatus: body.orderStatus
    };
    for (const [field, value] of Object.entries(optionalStrings)) {
        if (value !== undefined && value !== null && typeof value !== "string") {
            return res.status(400).json({
                success: false,
                message: `${field} must be a string`
            });
        }
    }
    let createdAt = optionalStrings.createdAt;
    if (createdAt !== undefined && createdAt !== null) {
        if (typeof createdAt !== "string" || !createdAt.trim() || !Number.isFinite(Date.parse(createdAt))) {
            return res.status(400).json({
                success: false,
                message: "createdAt must be a valid date string"
            });
        }
        createdAt = new Date(createdAt).toISOString();
    }
    let amount = body.amount;
    if (amount !== undefined && amount !== null) {
        if (typeof amount === "string" && /^\d+(?:\.\d+)?$/.test(amount)) {
            amount = Number(amount);
        }
        if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({
                success: false,
                message: "amount must be a positive number"
            });
        }
    }

    try {
        const result = await queryOrderDatabase(`
            UPDATE orders SET
                payment_status = ?,
                partner_code = COALESCE(?, partner_code),
                partner_name = COALESCE(?, partner_name),
                partner_invoice_id = COALESCE(?, partner_invoice_id),
                partner_invoice = COALESCE(?, partner_invoice),
                partner_reference_id = COALESCE(?, partner_reference_id),
                parner_ref_number = COALESCE(?, parner_ref_number),
                currency = COALESCE(?, currency),
                amount = COALESCE(?, amount),
                created_at = COALESCE(?, created_at),
                status_description = COALESCE(?, status_description),
                completed_date_time = COALESCE(?, completed_date_time),
                payment_status_code = COALESCE(?, payment_status_code),
                order_status = COALESCE(?, order_status)
            WHERE order_ref_id = ?
        `, [
            paymentStatus,
            optionalStrings.partnerCode ?? null,
            optionalStrings.partnerName ?? null,
            optionalStrings.PartnerInvoice ?? null,
            optionalStrings.PartnerInvoice ?? null,
            optionalStrings.ParnerRefNumber ?? null,
            optionalStrings.ParnerRefNumber ?? null,
            optionalStrings.currency ?? null,
            amount ?? null,
            createdAt ?? null,
            optionalStrings.statusDescription ?? null,
            optionalStrings.completedDateTime ?? null,
            optionalStrings.PaymentStatusCode ?? null,
            optionalStrings.orderStatus ?? null,
            orderRefId
        ]);
        if (result.rowCount === 0) {
            return res.status(404).json({
                success: false,
                message: "Order not found"
            });
        }
        return res.json({ success: true, data: { orderRefId, paymentStatus } });
    } catch (error) {
        console.error("Unable to update payment status in PostgreSQL:", error);
        return res.status(500).json({
            success: false,
            message: "Unable to update payment status in PostgreSQL"
        });
    }
});

app.post("/api/local/orders/clear", async (req, res) => {
    try {
        const result = await queryOrderDatabase("DELETE FROM orders");
        return res.json({ success: true, deletedCount: result.rowCount });
    } catch (error) {
        console.error("Unable to clear orders from PostgreSQL:", error);
        return res.status(500).json({
            success: false,
            message: "Unable to clear orders from PostgreSQL"
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

        let digitalId;
        try {
            digitalId = getDigitalIdFromWebInitToken(webinitToken);
        } catch (error) {
            return res.status(401).json({ success: false, message: error.message });
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
        await persistOrderResponse(response.data, requestBody, digitalId);
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
    if (typeof payload.amount !== "number" || !Number.isFinite(payload.amount) || payload.amount <= 0) {
        return "amount must be a positive number.";
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
            if (label === "DP create order") {
                console.log(`[${label}] Decrypted Response Body:`, response.data);
            }
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
        let digitalId;
        try {
            digitalId = getDigitalIdFromWebInitToken(webinitToken);
        } catch (error) {
            return res.status(401).send(error.message);
        }
        const partnerId = (req.get("x-partner-id") || "").trim() || null;
        if (partnerId && !Object.hasOwn(partnerLandingPages, partnerId)) {
            return res.status(400).send("Unknown x-partner-id.");
        }
        const plaintextBody = JSON.stringify(orderPayload);
        const encryptedBody = await encryptDpBody(plaintextBody);
        const response = await dpRequest("DP create order", "post", DP_ORDERS_URL,
            webinitToken, {
                body: encryptedBody,
                accessToken
            });
        await persistOrderResponse(response.data, orderPayload, digitalId, partnerId);
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
                accessToken: req.get("x-access-token")
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

app.use("/api", (req, res) => {
    return res.status(404).json({
        success: false,
        message: "API endpoint not found"
    });
});

app.use("/api", (error, req, res, next) => {
    if (res.headersSent) return next(error);

    console.error("API request failed:", error);
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
        ? error.status
        : 500;
    const message = error.type === "entity.parse.failed"
        ? "Request body must contain valid JSON"
        : status < 500 ? "Invalid API request" : "Internal server error";
    return res.status(status).json({ success: false, message });
});

const PORT = process.env.PORT || 10000;

async function startServer() {
    if (!postgresPool) {
        throw new Error("DATABASE_URL must be set to start the server.");
    }

    await initializePostgresSchema();
    app.listen(PORT, "0.0.0.0", (error) => {
        if (error) {
            console.error(`Unable to start server on port ${PORT}: ${error.message}`);
            process.exitCode = 1;
            return;
        }
        console.log(`Server running on port ${PORT}`);
    });
}

startServer().catch(error => {
    console.error("Unable to start server:", error);
    process.exitCode = 1;
});