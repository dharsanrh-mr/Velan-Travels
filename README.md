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

> **Upgrading again — driver login now requires a PIN.** `drivers.pin_hash` is added automatically to an existing DB on startup (no need to delete it this time). Any driver that doesn't have a PIN yet is auto-assigned one equal to the last 4 digits of their mobile number, and the server logs it on startup — tell drivers to change it from the admin panel. New drivers must be given a 4–6 digit PIN when added.

## API
POST `/api/auth/login`
POST `/api/auth/logout` *(admin)*
POST `/api/bookings`
GET `/api/bookings/:bookingId`
GET `/api/admin/dashboard` *(admin)*
GET `/api/admin/analytics` *(admin)* — revenue by month, top routes, top vehicles
GET `/api/admin/customers?q=` *(admin)*
GET `/api/admin/activity` *(admin)* — recent booking activity feed
PATCH `/api/admin/settings/password` *(admin)*
GET `/api/admin/bookings?status=&date=&q=` *(admin)*
PATCH `/api/admin/bookings/:id/status` *(admin)*
PATCH `/api/admin/bookings/:id/driver` *(admin)*
GET `/api/vehicles`
POST `/api/admin/vehicles` *(admin)*
PATCH `/api/admin/vehicles/:id` *(admin)*
GET `/api/drivers`
POST `/api/admin/drivers` *(admin)*
PATCH `/api/admin/drivers/:id` *(admin)*

## Notes for further hardening (production)
- Sessions are kept in-memory (`Map`) — they reset on server restart and won't work across multiple server instances. Move to a database-backed or Redis session store for production/scale.
- Add HTTPS in front of this (reverse proxy / hosting platform).
- Consider rate-limiting `/api/auth/login` and `/api/driver/login` against brute force.
- Admin-set driver PINs currently have no format check beyond 4–6 digits — consider forcing drivers to change the default (last-4-of-mobile) PIN on first login.
- `/api/admin/bookings` and `/api/admin/customers` are capped at 500 rows per request (`?limit=&offset=` to page). The current admin UI doesn't have pagination controls yet — add them if booking volume grows past that.
