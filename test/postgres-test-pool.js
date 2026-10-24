function createPostgresMock() {
    const queries = [];
    const rows = [];
    let tableExists = false;
    const orderColumns = [
        "order_ref_id", "partner_reference_id", "partner_invoice_id", "currency", "amount",
        "created_at", "payment_status", "order_status", "partner_code", "partner_name",
        "partner_invoice", "parner_ref_number", "status_description", "completed_date_time",
        "payment_status_code", "digital_id"
    ];

    function splitSqlList(value) {
        const parts = [];
        let depth = 0;
        let start = 0;
        for (let index = 0; index < value.length; index++) {
            if (value[index] === "(") depth++;
            if (value[index] === ")") depth--;
            if (value[index] === "," && depth === 0) {
                parts.push(value.slice(start, index).trim());
                start = index + 1;
            }
        }
        parts.push(value.slice(start).trim());
        return parts;
    }

    function execute(sql, parameters = []) {
        const statement = sql.trim().replace(/;$/, "");
        if (/^CREATE TABLE IF NOT EXISTS orders\b/i.test(statement)) {
            tableExists = true;
            return { rows: [], rowCount: null };
        }
        if (/^CREATE INDEX IF NOT EXISTS\b/i.test(statement)) {
            return { rows: [], rowCount: null };
        }
        if (/^DROP TABLE orders\b/i.test(statement)) {
            tableExists = false;
            rows.length = 0;
            return { rows: [], rowCount: null };
        }
        if (!tableExists) {
            throw new Error('relation "orders" does not exist');
        }

        const insertMatch = statement.match(
            /^INSERT INTO orders\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)(?:\s*ON CONFLICT\s*\(order_ref_id\)\s*DO UPDATE SET[\s\S]*)?$/i
        );
        if (insertMatch) {
            const columns = insertMatch[1].split(",").map(column => column.trim());
            const values = insertMatch[2].split(",").map((_, index) => parameters[index]);
            const inserted = Object.fromEntries(orderColumns.map(column => [column, null]));
            Object.assign(inserted, Object.fromEntries(
                columns.map((column, index) => [column, values[index]])
            ));
            const existing = rows.find(row => row.order_ref_id === inserted.order_ref_id);
            if (existing) {
                const previousDigitalId = existing.digital_id;
                Object.assign(existing, inserted);
                if (inserted.digital_id == null) existing.digital_id = previousDigitalId ?? null;
            } else {
                rows.push(inserted);
            }
            return { rows: [], rowCount: 1 };
        }

        const updateMatch = statement.match(/^UPDATE\s+orders\s+SET\s+([\s\S]+?)\s+WHERE\s+([\s\S]+)$/i);
        if (updateMatch) {
            const assignments = splitSqlList(updateMatch[1]);
            const whereMatch = updateMatch[2].match(/^([a-z_]+)\s*=\s*(?:\$(\d+)|\?|\'([^\']*)\')$/i);
            if (!whereMatch) throw new Error(`Unsupported test query: ${statement}`);
            const targetValue = whereMatch[2]
                ? parameters[Number(whereMatch[2]) - 1]
                : whereMatch[3] !== undefined
                    ? whereMatch[3]
                    : parameters.at(-1);
            const matched = rows.filter(row => row[whereMatch[1]] === targetValue);
            for (const row of matched) {
                let parameterCursor = 0;
                for (const assignment of assignments) {
                    const match = assignment.match(/^([a-z_]+)\s*=\s*(?:COALESCE\((?:\$(\d+)|\?),\s*([a-z_]+)\)|(?:\$(\d+)|\?)|'([^']*)')$/i);
                    if (!match) throw new Error(`Unsupported test assignment: ${assignment}`);
                    const [, column, coalesceIndex, fallbackColumn, directIndex, literal] = match;
                    const hasParameter = coalesceIndex !== undefined || directIndex !== undefined ||
                        assignment.includes("?");
                    const value = hasParameter
                        ? parameters[coalesceIndex || directIndex
                            ? Number(coalesceIndex || directIndex) - 1
                            : parameterCursor++]
                        : literal;
                    row[column] = fallbackColumn
                        ? value ?? row[fallbackColumn]
                        : value;
                }
            }
            return { rows: [], rowCount: matched.length };
        }

        if (/^DELETE FROM orders$/i.test(statement)) {
            const deletedCount = rows.length;
            rows.length = 0;
            return { rows: [], rowCount: deletedCount };
        }

        const selectMatch = statement.match(
            /^SELECT\s+([\s\S]+?)\s+FROM orders(?:\s+WHERE\s+([a-z_]+)\s*=\s*(?:\$(\d+)|\?|\'([^\']*)'))?(?:\s+ORDER BY\s+([\s\S]+))?$/i
        );
        if (selectMatch) {
            let selectedRows = rows;
            if (selectMatch[2]) {
                const value = selectMatch[3]
                        ? parameters[Number(selectMatch[3]) - 1]
                        : selectMatch[4] !== undefined
                            ? selectMatch[4]
                            : parameters[0];
                selectedRows = selectedRows.filter(row => row[selectMatch[2]] === value);
            }
            if (selectMatch[5]) {
                const sortFields = selectMatch[5].split(",").map(field => {
                    const [column, direction] = field.trim().split(/\s+/);
                    return { column, descending: direction?.toUpperCase() === "DESC" };
                });
                selectedRows = [...selectedRows].sort((a, b) => {
                    for (const { column, descending } of sortFields) {
                        if (a[column] === b[column]) continue;
                        const comparison = a[column] < b[column] ? -1 : 1;
                        return descending ? -comparison : comparison;
                    }
                    return 0;
                });
            }
            if (/^count\(\*\)\s+AS\s+count$/i.test(selectMatch[1].trim())) {
                return { rows: [{ count: selectedRows.length }], rowCount: 1 };
            }
            const columns = selectMatch[1].trim() === "*"
                ? null
                : selectMatch[1].split(",").map(column => column.trim());
            const resultRows = selectedRows.map(row => columns
                ? Object.fromEntries(columns.map(column => [column, row[column] ?? null]))
                : { ...row });
            return { rows: resultRows, rowCount: resultRows.length };
        }

        throw new Error(`Unsupported test query: ${statement}`);
    }

    const database = {
        exec(sql) {
            execute(sql);
        },
        prepare(sql) {
            return {
                run(...parameters) {
                    return execute(sql, parameters);
                },
                all(...parameters) {
                    return execute(sql, parameters).rows;
                },
                get(...parameters) {
                    return execute(sql, parameters).rows[0];
                }
            };
        },
        close() {}
    };

    class Pool {
        constructor(options) {
            if (!options.connectionString) {
                throw new Error("DATABASE_URL is required.");
            }
        }

        async query(sql, parameters = []) {
            queries.push({ sql, parameters });
            return execute(sql.replace(/\$\d+/g, "?"), [...parameters]);
        }
    }

    return { Pool, database, queries };
}

module.exports = { createPostgresMock };
