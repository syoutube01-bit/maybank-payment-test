# Maybank payment test service

## Render PostgreSQL

Create a PostgreSQL database in Render and add its **Internal Database URL** to the
web service as the `DATABASE_URL` environment variable. On startup, the app
connects to PostgreSQL and creates the snake_case `orders` table and its index
before it starts listening. If connecting with an external Render database URL,
set `PGSSL=true` as well.

When `DATABASE_URL` is not set, the app uses `data/orders.sqlite` for local
development. Existing SQLite databases with the original mixed-case columns
are upgraded in place to snake_case when opened.

To copy local SQLite orders into PostgreSQL, make the SQLite file available on
the machine running the command, set `DATABASE_URL` to the target database, and
run:

```sh
npm run migrate:postgres
```

For a SQLite file at another location:

```sh
npm run migrate:postgres -- --source /path/to/orders.sqlite
```

The migration is safe to rerun: existing rows are updated by `order_ref_id`,
and an existing `digital_id` is preserved if the SQLite row does not contain
one. It does not delete or modify the source SQLite file.
