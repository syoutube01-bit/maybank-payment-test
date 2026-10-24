# Maybank payment test service

## Render PostgreSQL

Create a PostgreSQL database in Render and add its **Internal Database URL** to the
web service as the `DATABASE_URL` environment variable. On startup, the app
connects to PostgreSQL and creates the snake_case `orders` table and its index
before it starts listening. `DATABASE_URL` is required; the app does not use a
local SQLite database or another storage fallback. Startup fails if PostgreSQL
cannot be reached or its schema cannot be initialized. Requests that cannot read
or write PostgreSQL return an error instead of reporting success.

If connecting with an external Render database URL, set `PGSSL=true` as well.
