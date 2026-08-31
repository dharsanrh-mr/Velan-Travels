# Velan Travels — Phase 1 + Admin/Booking Enhancements

A travel booking system: customer-facing booking site + an admin panel to manage bookings, vehicles and drivers.

## Included
- Customer website (home, booking form, booking-status lookup)
- Unique Booking ID generation
- Live fare estimate on the booking form (base fare + rate/km, per vehicle)
- Admin login (hashed passwords, session tokens with 12h expiry)
- Admin dashboard with booking counts
- Analytics: revenue by month, top routes, top-performing vehicles
- Booking management: status updates, driver assignment, search & filter (by status / date / name / mobile / booking ID)
- Vehicle management: add / edit vehicles, per-vehicle base fare & rate per km, availability status
- Driver management: add / edit drivers, assign a vehicle, availability status
- Printable booking-status card for customers
- SMS / WhatsApp notifications (via Twilio) to customers and drivers on booking, status changes, and driver assignment
- Mobile-responsive nav (hamburger menu) and forms
- Express backend API + SQLite database (schema/seed included)

## Run
1. Install Node.js 18+.
2. `cd backend && npm install`
3. Copy `.env.example` to `.env` and adjust if needed.
4. `npm start`
5. Open `http://localhost:4000`

The frontend is served by the backend from `frontend/`.

Demo admin:
- Email: admin@velantravels.com
- Password: admin123

**Change `ADMIN_PASSWORD` in `.env` before the server's first run in production** — it is only read once, to create the initial admin account. From then on the password is stored as a salted hash in the database, and further changes to `.env` have no effect on that existing account.

> **Upgrading from the original Phase-1 build?** The schema added new columns (`vehicles.base_fare`, `vehicles.rate_per_km`, `vehicles.ac`, `vehicles.fuel_type`, `bookings.estimated_distance_km`, `bookings.estimated_fare`) and a real `admins` table. Since `CREATE TABLE IF NOT EXISTS` won't alter an existing table, delete the old `velan-travels.db` file before starting so it's recreated with the new schema (you'll lose any existing demo data — re-seed with `database/seed.sql` if needed).

> **Upgrading again — driver login now requires a PIN.** `drivers.pin_hash` is added automatically to an existing DB on startup (no need to delete it this time). Any driver that doesn't have a PIN yet is auto-assigned one equal to the last 4 digits of their mobile number, and the server logs it on startup — they'll be prompted to change it on their next login (see below).

> **Upgrading again — DB-backed sessions, driver PIN force-change, admin pagination.** All automatic on startup, no need to delete the DB: a `sessions` table replaces the old in-memory session store (admin/driver logins now survive a restart), and `drivers.pin_is_default` is added to track who's still on their auto-assigned default PIN.

## SMS / WhatsApp notifications
Optional — off by default in the sense that with no Twilio credentials, every notification is just printed to the server console instead of sent, so nothing breaks if you skip this.

To turn it on:
1. Create a free trial account at https://www.twilio.com and grab your **Account SID** and **Auth Token** from the console.
2. For SMS: buy/use a Twilio number and set `TWILIO_SMS_FROM` to it.
3. For WhatsApp: use Twilio's WhatsApp sandbox for testing (`TWILIO_WHATSAPP_FROM=whatsapp:+14155238886`, and have each test recipient send the sandbox's "join" code once) — for production you need an approved WhatsApp Business sender.
4. Set `NOTIFY_CHANNEL` to `sms`, `whatsapp`, or `both` in `.env`.
5. `npm install` (pulls in the `twilio` package) and restart the server.

Trial Twilio accounts can only message phone numbers you've manually verified in the console — fine for testing, but you'll need a paid account to message arbitrary customers in production.

Messages are sent for: new booking received, every status change (confirmed / driver assigned / on trip / completed / cancelled), and driver assignment (both the driver and the customer are notified, with each other's contact details). A failed send (bad number, Twilio error, etc.) is logged and never blocks the booking/status API call itself.

## Google Maps auto distance calc
Optional — off by default (no keys = the booking form falls back to manual "enter distance in km" like before, nothing breaks).

To turn it on:
1. In https://console.cloud.google.com, create/select a project and enable **Places API** and **Distance Matrix API**.
2. Create two separate API keys (Credentials → Create Credentials → API key):
   - **Browser key** → restrict by *HTTP referrers* to your site's domain(s), and by API to *Places API* only. Set as `GOOGLE_MAPS_BROWSER_KEY`. This one is sent to the browser on purpose (for the pickup/drop autocomplete box) — the referrer restriction is what keeps it safe to expose.
   - **Server key** → restrict by *IP address* to your server, and by API to *Distance Matrix API* only. Set as `GOOGLE_MAPS_SERVER_KEY`. This one never leaves the server.
3. Restart the server.

With both set: pickup/drop fields on step 1 of the booking wizard get Google Places autocomplete, and once both are chosen the distance (km) field auto-fills from the Distance Matrix API — the customer can still edit it by hand if they want. Google's Distance Matrix API is billed per request past the free monthly credit; see https://mapsplatform.google.com/pricing/.

## API
POST `/api/auth/login`
POST `/api/auth/logout` *(admin)*
POST `/api/bookings`
GET `/api/bookings/:bookingId`
GET `/api/admin/dashboard` *(admin)*
GET `/api/admin/analytics` *(admin)* — revenue by month, top routes, top vehicles
GET `/api/admin/customers?q=` *(admin)* — paginated (`?limit=&offset=`, default 50/page), total count in `X-Total-Count` header
GET `/api/admin/activity` *(admin)* — recent booking activity feed
PATCH `/api/admin/settings/password` *(admin)*
GET `/api/admin/bookings?status=&date=&q=` *(admin)* — paginated (`?limit=&offset=`, default 50/page), total count in `X-Total-Count` header
PATCH `/api/admin/bookings/:id/status` *(admin)*
PATCH `/api/admin/bookings/:id/driver` *(admin)*
GET `/api/config` — public frontend config (Maps browser key, if set)
GET `/api/distance?pickup=&drop=` — auto distance calc (Google Distance Matrix)
POST `/api/driver/login`
PATCH `/api/driver/pin` *(driver)* — change own PIN (required when login returns `pinIsDefault: true`)
GET `/api/driver/bookings` *(driver)*
PATCH `/api/driver/bookings/:id/status` *(driver)*
GET `/api/vehicles`
POST `/api/admin/vehicles` *(admin)*
PATCH `/api/admin/vehicles/:id` *(admin)*
GET `/api/drivers`
POST `/api/admin/drivers` *(admin)*
PATCH `/api/admin/drivers/:id` *(admin)*

## Deploying

**Render (easiest — free tier available):**
1. Push this folder to a GitHub repo.
2. In Render: New → Web Service → connect the repo.
3. Root directory: `backend`. Build command: `npm install`. Start command: `npm start`.
4. Add environment variables under Settings → Environment (all the ones from `.env.example`: `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `NOTIFY_*`/`TWILIO_*` if using SMS, `GOOGLE_MAPS_*` if using auto distance).
5. Render gives you a public HTTPS URL automatically — no reverse proxy setup needed.
6. ⚠️ Render's free tier has an *ephemeral filesystem* — the SQLite file (`velan-travels.db`) is wiped on every redeploy/restart. Fine for a demo; for production either upgrade to a paid instance with a persistent disk (Render → Disks), or migrate to a hosted Postgres/MySQL database.

**Railway:** same idea — New Project → Deploy from GitHub → set root directory to `backend` → add the same environment variables. Railway volumes can persist the SQLite file across restarts (Settings → Volumes → mount at `/app` or wherever `velan-travels.db` resolves to).

**DigitalOcean / any VPS (Ubuntu):**
1. `git clone` the repo onto the droplet, `cd backend && npm install`.
2. Create `.env` from `.env.example` with real values.
3. Run it under a process manager so it survives reboots/crashes: `npm install -g pm2 && pm2 start src/server.js --name velan-travels && pm2 save && pm2 startup`.
4. Put Nginx in front for HTTPS: point a domain at the droplet, `certbot --nginx` for a free TLS cert, and reverse-proxy port 80/443 → `localhost:4000`.
5. Here the SQLite file lives on real disk and persists normally — just make sure you're backing up `velan-travels.db` periodically (e.g. a cron job copying it to S3/Spaces).

Whichever host you pick, remember the in-memory session store note below — a restart logs every admin out, and it won't work if you ever scale to more than one server instance.

## Notes for further hardening (production)
- ~~Sessions are kept in-memory~~ — now stored in a `sessions` table in SQLite, so admin/driver logins survive a server restart. Still not multi-instance-safe as written (SQLite is single-file) — move to Postgres/Redis if you ever run more than one server instance behind a load balancer.
- Add HTTPS in front of this (reverse proxy / hosting platform) — see the Deploying section above.
- ~~Consider rate-limiting `/api/auth/login` and `/api/driver/login`~~ — done: both are capped at 8 attempts per 15 minutes per IP+identifier, returning 429 with a `Retry-After` header once exceeded. It's in-memory (resets on restart) — fine for a single instance; swap for a Redis-backed limiter if you scale out.
- ~~Admin-set driver PINs currently have no format check beyond 4–6 digits — consider forcing drivers to change the default (last-4-of-mobile) PIN on first login~~ — done: `drivers.pin_is_default` tracks this, `/api/driver/login` returns `pinIsDefault: true` when it applies, and the driver app forces a PIN-change screen before showing trips. Drivers can also change their PIN anytime from the "Change PIN" button on their trips dashboard.
- ~~`/api/admin/bookings` and `/api/admin/customers` are capped at 500 rows per request... current admin UI doesn't have pagination controls yet~~ — done: both endpoints now default to 50 rows/page (still cap at 500 via `?limit=`) and return an `X-Total-Count` header; the Bookings and Customers admin pages have Prev/Next controls.
