# Maybank payment test service

## Local development

Start a local PostgreSQL instance and create a dedicated database. For Homebrew
PostgreSQL 18 on macOS:

```sh
brew services start postgresql@18
createdb -h localhost maybank_payment_test
```

Add the connection URL to a `.env` file in the project root:

```dotenv
DATABASE_URL=postgresql://localhost:5432/maybank_payment_test
```

This local URL uses your operating-system username with PostgreSQL's local
authentication configuration. If your instance requires a different role or a
password, use its connection URL instead. Do not enable `PGSSL=true` for a local
instance unless it is configured for TLS.

Run `npm start`, then open
<http://localhost:10000/easybook-landing.html?partnerId=mbb-mae-easybook>.
The start command loads `.env` when present; existing environment variables take
precedence. `.env` is ignored by Git and must not be committed. To use a different
HTTP port, set `PORT` in `.env` or the environment.

## Render PostgreSQL

Create a PostgreSQL database in Render and add its **Internal Database URL** to the
web service as the `DATABASE_URL` environment variable. On startup, the app
connects to PostgreSQL and creates the snake_case `orders` table and its index
before it starts listening. `DATABASE_URL` is required; the app does not use a
local SQLite database or another storage fallback. Startup fails if PostgreSQL
cannot be reached or its schema cannot be initialized. Requests that cannot read
or write PostgreSQL return an error instead of reporting success.

If connecting with an external Render database URL, set `PGSSL=true` as well.
