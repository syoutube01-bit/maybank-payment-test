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

## My Orders

On the CTOS landing page, use **Edit** beside the amount to enter a positive MYR
amount with up to two decimal places, then **Save**. The displayed amount and
create-order request use the saved value for the current page session. Buy is
disabled until the edit is saved; reloading resets the amount to RM100.

On the CTOS landing page, the API test link is hidden. Double-click the CTOS
brand (the CTOS Score text) to open `/index.html`, retaining the current launch
query parameters.
Easybook and eSIM use the same hidden API test link; double-click their respective
wordmarks to open it with the current launch query parameters.

The CTOS, Easybook and eSIM landing pages and [My Orders](public/my-orders.html)
share the same responsive order cards and loading logic. All four views request
`/api/my/orders` using the MAE native web-init token and show the current user's
orders, including older orders without a partner ID. The `partnerId` query
parameter on the dedicated screen sets the partner heading and back navigation;
it does not filter the list. Open these screens inside MAE to use the native
bridge. Loading failures are displayed in the order section, with a refresh
button to retry.

On My Orders, **Order ID** and **Invoice ID** request the corresponding DP lookup
API and open [Payment Status](public/lookup-payment-status.html) with the returned
order details. Lookups accept DP responses with details under `order`,
`responseData`, or `data`, as well as unwrapped order details.
Both lookups use an in-page modal with a labelled input, Cancel and OK controls,
without the browser-native website heading. Escape also cancels the dialog.
After submitting either lookup dialog, a spinner is displayed until the request
finishes. Lookup and refresh buttons are disabled while it runs; errors stop the
spinner and remain visible for retry.
This display-only screen shares the existing payment receipt
layout but does not fetch local orders or initiate/update a payment. Lookup
results are kept in the current tab's session storage (not in the URL), so the
screen can be refreshed. Missing response fields are shown as "Not provided";
failed or invalid lookups stay on My Orders with an error. Opening the screen
without a saved lookup shows an error. Existing order cards and payment deep
links continue to use the original payment status flow.

## Render PostgreSQL

Create a PostgreSQL database in Render and add its **Internal Database URL** to the
web service as the `DATABASE_URL` environment variable. On startup, the app
connects to PostgreSQL and creates the snake_case `orders` table and its index
before it starts listening. `DATABASE_URL` is required; the app does not use a
local SQLite database or another storage fallback. Startup fails if PostgreSQL
cannot be reached or its schema cannot be initialized. Requests that cannot read
or write PostgreSQL return an error instead of reporting success.

If connecting with an external Render database URL, set `PGSSL=true` as well.
