const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Pool } = require("pg");

const defaultSource = path.join(__dirname, "..", "data", "orders.sqlite");
const sourceArgumentIndex = process.argv.indexOf("--source");
const sourcePath = path.resolve(
    sourceArgumentIndex === -1 ? defaultSource : process.argv[sourceArgumentIndex + 1] || ""
);
const databaseUrl = process.env.DATABASE_URL;
const columns = [
    "order_ref_id", "partner_reference_id", "partner_invoice_id", "currency", "amount",
    "created_at", "payment_status", "order_status", "partner_code", "partner_name",
    "partner_invoice", "parner_ref_number", "status_description", "completed_date_time",
    "payment_status_code", "digital_id"
];
const legacyNames = {
    order_ref_id: ["order_ref_id", "orderRefId"],
    partner_reference_id: ["partner_reference_id", "partnerReferenceId"],
    partner_invoice_id: ["partner_invoice_id", "partnerInvoiceId"],
    currency: ["currency"],
    amount: ["amount"],
    created_at: ["created_at", "createdAt"],
    payment_status: ["payment_status", "paymentStatus"],
    order_status: ["order_status", "orderStatus"],
    partner_code: ["partner_code", "partnerCode"],
    partner_name: ["partner_name", "partnerName"],
    partner_invoice: ["partner_invoice", "PartnerInvoice"],
    parner_ref_number: ["parner_ref_number", "ParnerRefNumber"],
    status_description: ["status_description", "statusDescription"],
    completed_date_time: ["completed_date_time", "completedDateTime"],
    payment_status_code: ["payment_status_code", "PaymentStatusCode"],
    digital_id: ["digital_id", "digitalId"]
};

async function migrate() {
    if (!databaseUrl) {
        throw new Error("DATABASE_URL must point to the target PostgreSQL database.");
    }
    if (sourceArgumentIndex !== -1 && !process.argv[sourceArgumentIndex + 1]) {
        throw new Error("Provide a path after --source.");
    }
    if (!fs.existsSync(sourcePath)) {
        throw new Error(`SQLite source database was not found: ${sourcePath}`);
    }

    const sqlite = new DatabaseSync(sourcePath, { readOnly: true });
    const pool = new Pool({
        connectionString: databaseUrl,
        ...(process.env.PGSSL === "true" ? { ssl: { rejectUnauthorized: false } } : {})
    });
    try {
        const availableColumns = new Set(
            sqlite.prepare("PRAGMA table_info(orders)").all().map(column => column.name)
        );
        if (!availableColumns.size) {
            throw new Error("The SQLite source does not contain an orders table.");
        }
        const rows = sqlite.prepare("SELECT * FROM orders").all().map(row =>
            Object.fromEntries(columns.map(column => {
                const sourceColumn = legacyNames[column].find(name => availableColumns.has(name));
                return [column, sourceColumn ? row[sourceColumn] ?? null : null];
            }))
        );

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(`
                CREATE TABLE IF NOT EXISTS orders (
                    order_ref_id TEXT PRIMARY KEY,
                    partner_reference_id TEXT NOT NULL,
                    partner_invoice_id TEXT NOT NULL,
                    currency TEXT NOT NULL,
                    amount INTEGER NOT NULL,
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
                    digital_id TEXT
                )
            `);
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_orders_digital_id
                ON orders (digital_id, created_at)
            `);

            const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
            const updates = columns
                .filter(column => column !== "order_ref_id")
                .map(column => column === "digital_id"
                    ? "digital_id = COALESCE(EXCLUDED.digital_id, orders.digital_id)"
                    : `${column} = EXCLUDED.${column}`)
                .join(", ");
            const insert = `INSERT INTO orders (${columns.join(", ")})
                VALUES (${placeholders})
                ON CONFLICT (order_ref_id) DO UPDATE SET ${updates}`;
            for (const row of rows) {
                await client.query(insert, columns.map(column => row[column]));
            }
            await client.query("COMMIT");
            console.log(`Migrated ${rows.length} order(s) from ${sourcePath} to PostgreSQL.`);
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    } finally {
        sqlite.close();
        await pool.end();
    }
}

migrate().catch(error => {
    console.error("SQLite to PostgreSQL migration failed:", error.message);
    process.exitCode = 1;
});
