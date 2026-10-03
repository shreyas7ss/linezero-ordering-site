# LineZero Ordering Site

This folder is a standalone Cloudflare Pages app. It contains only the website,
its Pages Functions, and the assets needed to deploy it; it does not depend on
the parent CanteenPro repository or its Git submodule.

## New repository and Pages setup

1. Create a new, empty GitHub repository. Copy the **contents** of this folder
   into that repository's root and push them to the `main` branch.
2. In Cloudflare, create a **Pages** project connected to the new repository.
   Set framework preset to **None**, build command to blank, and build output
   directory to `static`. Leave the root directory blank because this is now
   the repository root. Use `main` as the production branch.
3. Add these production variables and secrets in the Pages project settings:
   - `SUPABASE_URL` (variable)
   - `SUPABASE_SERVICE_ROLE_KEY` (secret)
   - `UPI_VPA` (secret or variable)
   - `UPI_PAYEE_NAME` (variable)
   - `TELEGRAM_BOT_TOKEN` (secret; required for Telegram Mini App checkout)
4. Deploy. Do not put Wrangler commands in the Pages build command; Cloudflare
   builds and deploys the project itself.

The database must already have the LineZero schema and menu in Supabase. The
service-role key is used only by Pages Functions and is never sent to browsers.

## Order flow

The root URL serves the order site. `/api/menu`, `/api/orders`, and
`/pay/{transaction_id}` are implemented by Pages Functions. Website orders
collect a student name and roll number, then open a UPI payment link. Telegram
Mini App orders use signed Telegram data and send payment and confirmation
buttons to the user's bot chat.

For Telegram to open this deployment, set `UPI_REDIRECT_BASE_URL` in the bot's
existing runtime environment to the Pages origin, such as
`https://linezero-ordering-site.pages.dev`. The `/app` rewrite preserves the
bot's existing Mini App URL.

Before accepting public traffic, configure rate limiting for `/api/orders`.