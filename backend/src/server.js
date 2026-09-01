require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { notify, sendOtp, bookingConfirmedMsg, statusUpdateMsg, driverAssignedCustomerMsg, tripAssignedDriverMsg } = require('./notify');
const { calcDistanceKm, mapsConfigured, GOOGLE_MAPS_BROWSER_KEY } = require('./maps');

const app = express();
const PORT = process.env.PORT || 4000;
const allowedOrigins = new Set(String(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.disable('x-powered-by');
const dbPath = path.join(__dirname, '../../velan-travels.db');
const db = new Database(dbPath);

db.pragma('foreign_keys = ON');
const schema = fs.readFileSync(path.join(__dirname, '../../database/schema.sql'), 'utf8');
db.exec(schema);

// ---------- migration: add drivers.pin_hash for existing DBs created before PIN login ----------
try { db.exec('ALTER TABLE drivers ADD COLUMN pin_hash TEXT'); } catch (e) { /* column already exists */ }
// ---------- migration: add drivers.pin_is_default for existing DBs ----------
try { db.exec('ALTER TABLE drivers ADD COLUMN pin_is_default INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* column already exists */ }
// ---------- migration: sessions table (DB-backed, replaces the old in-memory Map) ----------
db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, expires_at INTEGER NOT NULL
)`);
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); // sweep stale sessions on boot
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 60 * 60 * 1000).unref();

// ---------- migration: otps table for existing DBs created before customer login ----------
db.exec(`CREATE TABLE IF NOT EXISTS otps (
  id INTEGER PRIMARY KEY AUTOINCREMENT, mobile TEXT NOT NULL, otp_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
db.prepare('DELETE FROM otps WHERE expires_at < ?').run(Date.now()); // sweep stale OTPs on boot

// ---------- password hashing (scrypt, no extra native deps) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- driver PIN helpers (same scrypt scheme as admin passwords) ----------
const hashPin = hashPassword;
const verifyPin = verifyPassword;
function isValidPin(p) { return /^\d{4,6}$/.test(String(p || '').trim()); }

// ---------- backfill PINs for drivers that predate PIN login ----------
// Existing drivers (created before this update) have no pin_hash. Give each a
// default PIN of the last 4 digits of their mobile number so nobody is locked
// out, and log it so the admin knows to tell drivers to change it.
const driversMissingPin = db.prepare('SELECT id, mobile FROM drivers WHERE pin_hash IS NULL').all();
for (const d of driversMissingPin) {
  const defaultPin = String(d.mobile).slice(-4);
  db.prepare('UPDATE drivers SET pin_hash=?, pin_is_default=1 WHERE id=?').run(hashPin(defaultPin), d.id);
  console.log(`Driver #${d.id} (${d.mobile}) had no PIN — set default PIN "${defaultPin}" (last 4 digits of mobile). They'll be asked to change it on next login.`);
}

// ---------- seed / migrate the admin account ----------
const adminEmail = process.env.ADMIN_EMAIL || 'admin@velantravels.com';
const existingAdmin = db.prepare('SELECT * FROM admins WHERE email=?').get(adminEmail);
if (!existingAdmin) {
  const initialPassword = process.env.ADMIN_PASSWORD || 'admin123';
  db.prepare('INSERT INTO admins(name,email,password_hash) VALUES(?,?,?)')
    .run('Admin', adminEmail, hashPassword(initialPassword));
  console.log(`Seeded admin account: ${adminEmail}`);
}

// ---------- DB-backed session tokens (12h expiry) ----------
// Stored in SQLite instead of an in-memory Map so admin/driver logins survive
// a server restart, and (unlike a Map) would keep working if this were ever
// pointed at a shared DB from multiple server instances.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const insertSession = db.prepare('INSERT INTO sessions(token,kind,subject,expires_at) VALUES(?,?,?,?)');
const getSession = db.prepare('SELECT * FROM sessions WHERE token=?');
const deleteSession = db.prepare('DELETE FROM sessions WHERE token=?');
function issueToken(email) {
  const token = crypto.randomBytes(24).toString('hex');
  insertSession.run(token, 'admin', email, Date.now() + SESSION_TTL_MS);
  return token;
}
function issueDriverToken(driverId) {
  const token = crypto.randomBytes(24).toString('hex');
  insertSession.run(token, 'driver', String(driverId), Date.now() + SESSION_TTL_MS);
  return token;
}
function issueCustomerToken(mobile) {
  const token = crypto.randomBytes(24).toString('hex');
  insertSession.run(token, 'customer', mobile, Date.now() + SESSION_TTL_MS);
  return token;
}
function adminOnly(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const session = token && getSession.get(token);
  if (!session || session.kind !== 'admin' || session.expires_at < Date.now()) {
    if (token) deleteSession.run(token);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.adminEmail = session.subject;
  next();
}
function driverOnly(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const session = token && getSession.get(token);
  if (!session || session.kind !== 'driver' || session.expires_at < Date.now()) {
    if (token) deleteSession.run(token);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.driverId = Number(session.subject);
  next();
}
function customerOnly(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const session = token && getSession.get(token);
  if (!session || session.kind !== 'customer' || session.expires_at < Date.now()) {
    if (token) deleteSession.run(token);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.customerMobile = session.subject;
  next();
}

// ---------- login rate limiting (in-memory, per IP+identifier sliding window) ----------
// Intentionally in-memory even though sessions are now DB-backed: a reset on
// restart is fine for a rate limiter (worst case someone gets a few extra
// tries right after a deploy), and it avoids a DB write on every keystroke
// of a login attempt. For multi-instance deployments, swap this for a
// Redis-backed limiter.
const loginAttempts = new Map(); // key -> [timestamps]
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
function rateLimitLogin(keyFn) {
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    const attempts = (loginAttempts.get(key) || []).filter(t => now - t < LOGIN_WINDOW_MS);
    if (attempts.length >= LOGIN_MAX_ATTEMPTS) {
      const retryAfterSec = Math.ceil((LOGIN_WINDOW_MS - (now - attempts[0])) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
    }
    attempts.push(now);
    loginAttempts.set(key, attempts);
    next();
  };
}
// Periodic cleanup so loginAttempts doesn't grow unbounded over a long uptime.
setInterval(() => {
  const now = Date.now();
  for (const [key, attempts] of loginAttempts) {
    const fresh = attempts.filter(t => now - t < LOGIN_WINDOW_MS);
    if (fresh.length) loginAttempts.set(key, fresh); else loginAttempts.delete(key);
  }
}, 5 * 60 * 1000).unref();

// Lightweight abuse protection for unauthenticated public endpoints.
const publicAttempts = new Map();
const PUBLIC_WINDOW_MS = 60 * 1000;
const PUBLIC_MAX = 60;
function publicRateLimit(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const attempts = (publicAttempts.get(key) || []).filter(t => now - t < PUBLIC_WINDOW_MS);
  if (attempts.length >= PUBLIC_MAX) {
    res.set('Retry-After', '60');
    return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
  }
  attempts.push(now);
  publicAttempts.set(key, attempts);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [key, attempts] of publicAttempts) {
    const fresh = attempts.filter(t => now - t < PUBLIC_WINDOW_MS);
    if (fresh.length) publicAttempts.set(key, fresh); else publicAttempts.delete(key);
  }
}, 60 * 1000).unref();

// Production-safe HTTP defaults. CORS is closed by default because the frontend
// is served from this same Express app. Set CORS_ORIGINS only when a separate
// frontend origin genuinely needs API access.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
    "script-src 'self' https://maps.googleapis.com https://maps.gstatic.com",
    "connect-src 'self' https://maps.googleapis.com https://maps.gstatic.com",
    "img-src 'self' data: blob: https://maps.googleapis.com https://maps.gstatic.com",
    "style-src 'self' 'unsafe-inline'", "font-src 'self' data: https://fonts.gstatic.com", "object-src 'none'"
  ].join('; '));
  next();
});
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('CORS origin not allowed'));
  },
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600
}));
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '../../frontend'), {
  etag: true,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));

function makeBookingId() {
  // crypto.randomBytes instead of Math.random for a non-guessable, well-
  // distributed ID (Math.random isn't a CSPRNG and can repeat/cluster).
  return 'VT' + crypto.randomBytes(6).toString('hex').toUpperCase();
}
function isValidMobile(m) { return /^[6-9]\d{9}$/.test(String(m || '').trim()); }
function isPastDate(dateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr + 'T00:00:00');
  return d < today;
}
// Two bookings for the same vehicle on the same date conflict if their
// journey times fall within 2 hours of each other (rough turnaround buffer).
const CONFLICT_WINDOW_MIN = 120;
function timesConflict(t1, t2) {
  const [h1, m1] = t1.split(':').map(Number);
  const [h2, m2] = t2.split(':').map(Number);
  return Math.abs((h1 * 60 + m1) - (h2 * 60 + m2)) < CONFLICT_WINDOW_MIN;
}
function findVehicleConflict(vehicleId, date, time, excludeBookingRowId = null) {
  const rows = db.prepare(`
    SELECT * FROM bookings
    WHERE vehicle_id=? AND journey_date=? AND status NOT IN ('CANCELLED')
  `).all(vehicleId, date);
  return rows.find(r => r.id !== excludeBookingRowId && timesConflict(r.journey_time, time)) || null;
}
// Same idea, but for a driver — prevents assigning one driver to two trips
// that overlap in time, even across different vehicles.
function findDriverConflict(driverId, date, time, excludeBookingRowId = null) {
  const rows = db.prepare(`
    SELECT * FROM bookings
    WHERE driver_id=? AND journey_date=? AND status NOT IN ('CANCELLED')
  `).all(driverId, date);
  return rows.find(r => r.id !== excludeBookingRowId && timesConflict(r.journey_time, time)) || null;
}

// ---------- auth ----------
app.post('/api/auth/login', rateLimitLogin(req => 'admin:' + (req.ip || '') + ':' + (req.body?.email || '')), (req, res) => {
  const { email, password } = req.body || {};
  const admin = db.prepare('SELECT * FROM admins WHERE email=?').get(email);
  if (!admin || !verifyPassword(password || '', admin.password_hash))
    return res.status(401).json({ error: 'Invalid email or password' });
  res.json({ token: issueToken(admin.email), admin: { name: admin.name, email: admin.email } });
});
app.post('/api/auth/logout', adminOnly, (req, res) => {
  const header = req.headers.authorization || '';
  deleteSession.run(header.slice(7));
  res.json({ ok: true });
});

// ---------- driver auth (mobile number + PIN) ----------
app.post('/api/driver/login', rateLimitLogin(req => 'driver:' + (req.ip || '') + ':' + (req.body?.mobile || '')), (req, res) => {
  const mobile = String((req.body || {}).mobile || '').trim();
  const pin = String((req.body || {}).pin || '').trim();
  const driver = db.prepare('SELECT * FROM drivers WHERE mobile=?').get(mobile);
  // Same error for "no such driver" and "wrong PIN" so mobile numbers can't be enumerated.
  if (!driver || !driver.pin_hash || !verifyPin(pin, driver.pin_hash))
    return res.status(401).json({ error: 'Invalid mobile number or PIN' });
  res.json({
    token: issueDriverToken(driver.id),
    driver: { id: driver.id, name: driver.name },
    pinIsDefault: !!driver.pin_is_default,
  });
});

// ---------- driver: change own PIN (required if pinIsDefault came back true on login) ----------
app.patch('/api/driver/pin', driverOnly, (req, res) => {
  const { newPin } = req.body || {};
  if (!isValidPin(newPin)) return res.status(400).json({ error: 'PIN must be 4-6 digits' });
  db.prepare('UPDATE drivers SET pin_hash=?, pin_is_default=0, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(hashPin(String(newPin).trim()), req.driverId);
  res.json({ ok: true });
});

// ---------- driver: my assigned trips ----------
app.get('/api/driver/bookings', driverOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, c.name customer_name, c.mobile, v.name vehicle_name, v.vehicle_number
    FROM bookings b JOIN customers c ON c.id=b.customer_id
    LEFT JOIN vehicles v ON v.id=b.vehicle_id
    WHERE b.driver_id=? AND b.status NOT IN ('CANCELLED')
    ORDER BY b.journey_date, b.journey_time
  `).all(req.driverId);
  res.json(rows);
});

// ---------- driver: update trip status (limited transitions only) ----------
const DRIVER_ALLOWED_TRANSITIONS = { DRIVER_ASSIGNED: 'ON_TRIP', ON_TRIP: 'COMPLETED' };
app.patch('/api/driver/bookings/:id/status', driverOnly, (req, res) => {
  const row = db.prepare('SELECT * FROM bookings WHERE id=? AND driver_id=?').get(req.params.id, req.driverId);
  if (!row) return res.status(404).json({ error: 'Trip not found' });
  const nextAllowed = DRIVER_ALLOWED_TRANSITIONS[row.status];
  if (!nextAllowed || req.body.status !== nextAllowed)
    return res.status(400).json({ error: `Cannot move from ${row.status} to ${req.body.status}` });
  db.prepare('UPDATE bookings SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(nextAllowed, row.id);
  const cust = db.prepare('SELECT mobile FROM customers WHERE id=?').get(row.customer_id);
  if (cust) notify(cust.mobile, statusUpdateMsg({ bookingId: row.booking_id, status: nextAllowed }));
  res.json({ ok: true, status: nextAllowed });
});

// ---------- customer auth (mobile number + OTP) ----------
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const insertOtp = db.prepare('INSERT INTO otps(mobile,otp_hash,expires_at) VALUES(?,?,?)');
const getLatestOtp = db.prepare('SELECT * FROM otps WHERE mobile=? ORDER BY id DESC LIMIT 1');
const bumpOtpAttempts = db.prepare('UPDATE otps SET attempts=attempts+1 WHERE id=?');
const deleteOtpsFor = db.prepare('DELETE FROM otps WHERE mobile=?');
function makeOtp() {
  // crypto.randomInt (CSPRNG) instead of Math.random, same reasoning as makeBookingId.
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

app.post('/api/customer/otp/request',
  rateLimitLogin(req => 'otp-req:' + (req.ip || '') + ':' + (req.body?.mobile || '')),
  (req, res) => {
    const mobile = String((req.body || {}).mobile || '').trim();
    if (!isValidMobile(mobile)) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });
    const otp = makeOtp();
    deleteOtpsFor.run(mobile); // any earlier unused OTP for this number is now void
    insertOtp.run(mobile, hashPassword(otp), Date.now() + OTP_TTL_MS);
    sendOtp(mobile, otp);
    res.json({ ok: true });
  });

app.post('/api/customer/otp/verify',
  rateLimitLogin(req => 'otp-verify:' + (req.ip || '') + ':' + (req.body?.mobile || '')),
  (req, res) => {
    const mobile = String((req.body || {}).mobile || '').trim();
    const otp = String((req.body || {}).otp || '').trim();
    const row = getLatestOtp.get(mobile);
    if (!row || row.expires_at < Date.now())
      return res.status(401).json({ error: 'OTP expired or not found. Please request a new one.' });
    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      deleteOtpsFor.run(mobile);
      return res.status(401).json({ error: 'Too many incorrect attempts. Please request a new OTP.' });
    }
    if (!verifyPassword(otp, row.otp_hash)) {
      bumpOtpAttempts.run(row.id);
      return res.status(401).json({ error: 'Incorrect OTP' });
    }
    deleteOtpsFor.run(mobile);
    // Customer rows aren't unique-per-mobile (one is created per booking), so
    // just pull the most recent name on file for a friendlier welcome — the
    // booking history itself is looked up by mobile, not by a single row's id.
    const existing = db.prepare('SELECT name FROM customers WHERE mobile=? ORDER BY id DESC LIMIT 1').get(mobile);
    res.json({ token: issueCustomerToken(mobile), customer: { mobile, name: existing ? existing.name : '' } });
  });

app.post('/api/customer/logout', customerOnly, (req, res) => {
  const header = req.headers.authorization || '';
  deleteSession.run(header.slice(7));
  res.json({ ok: true });
});

// ---------- customer: my booking history ----------
app.get('/api/customer/bookings', customerOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, v.name vehicle_name, v.vehicle_number, d.name driver_name, d.mobile driver_mobile
    FROM bookings b
    JOIN customers c ON c.id = b.customer_id
    LEFT JOIN vehicles v ON v.id = b.vehicle_id
    LEFT JOIN drivers d ON d.id = b.driver_id
    WHERE c.mobile = ?
    ORDER BY b.created_at DESC
  `).all(req.customerMobile);
  res.json(rows);
});

// ---------- public: vehicles / drivers (read-only) ----------
app.get('/api/vehicles', (req, res) => {
  res.json(db.prepare('SELECT * FROM vehicles ORDER BY name').all());
});

// ---------- maps ----------
// Public, safe-to-expose config for the frontend (the Maps browser key is
// meant to be public — restrict it by HTTP referrer in Google Cloud Console).
app.get('/api/config', (req, res) => {
  res.json({ mapsBrowserKey: GOOGLE_MAPS_BROWSER_KEY || '', mapsEnabled: mapsConfigured });
});

app.get('/api/distance', publicRateLimit, async (req, res) => {
  const { pickup, drop } = req.query;
  if (!pickup || !drop) return res.status(400).json({ error: 'pickup and drop are required' });
  if (!mapsConfigured) return res.status(501).json({ error: 'Distance auto-calc not configured' });
  try {
    const result = await calcDistanceKm(String(pickup), String(drop));
    res.json(result);
  } catch (e) {
    console.error('[maps] distance lookup failed:', e.message);
    res.status(422).json({ error: 'Could not calculate distance for that route. Please enter it manually.' });
  }
});
app.get('/api/drivers', (req, res) => {
  // Explicit column list — never expose pin_hash, even by accident.
  res.json(db.prepare(`
    SELECT d.id, d.name, d.mobile, d.vehicle_id, d.status, d.created_at, d.updated_at,
           v.name AS vehicle_name, v.vehicle_number
    FROM drivers d LEFT JOIN vehicles v ON v.id=d.vehicle_id ORDER BY d.name
  `).all());
});

// ---------- bookings ----------
app.post('/api/bookings', publicRateLimit, (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.mobile || !b.pickup || !b.drop || !b.date || !b.time || !b.vehicleId || !b.passengers)
    return res.status(400).json({ error: 'Please fill all required fields' });
  if (!isValidMobile(b.mobile))
    return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });
  if (isPastDate(b.date))
    return res.status(400).json({ error: 'Journey date cannot be in the past' });
  if (Number(b.passengers) < 1)
    return res.status(400).json({ error: 'Passengers must be at least 1' });

  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id=?').get(b.vehicleId);
  if (!vehicle) return res.status(400).json({ error: 'Selected vehicle not found' });
  if (Number(b.passengers) > vehicle.seating_capacity)
    return res.status(400).json({ error: `${vehicle.name} seats only ${vehicle.seating_capacity} passengers` });

  const conflict = findVehicleConflict(vehicle.id, b.date, b.time);
  if (conflict)
    return res.status(409).json({ error: `${vehicle.name} is already booked around that time on ${b.date}. Please pick another vehicle or time.` });

  let estFare = null, estDistance = null;
  if (b.distanceKm) {
    estDistance = Number(b.distanceKm);
    estFare = Math.round(vehicle.base_fare + estDistance * vehicle.rate_per_km);
  }

  const customer = db.prepare('INSERT INTO customers(name,mobile) VALUES(?,?)').run(b.name, b.mobile);
  const insertBooking = db.prepare(`INSERT INTO bookings
    (booking_id,customer_id,pickup_location,drop_location,journey_date,journey_time,vehicle_id,passengers,additional_requirements,estimated_distance_km,estimated_fare)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  let bookingId;
  // booking_id is UNIQUE — retry with a fresh random ID on the astronomically
  // unlikely chance of a collision, instead of erroring out the whole booking.
  for (let attempt = 0; attempt < 5; attempt++) {
    bookingId = makeBookingId();
    try {
      insertBooking.run(bookingId, customer.lastInsertRowid, b.pickup, b.drop, b.date, b.time, b.vehicleId, Number(b.passengers), b.requirements || '', estDistance, estFare);
      break;
    } catch (e) {
      if (attempt === 4) throw e;
    }
  }
  notify(b.mobile, bookingConfirmedMsg({ bookingId, pickup: b.pickup, drop: b.drop, date: b.date, time: b.time, fare: estFare }));
  res.status(201).json({ bookingId, estimatedFare: estFare });
});

app.get('/api/bookings/:bookingId', (req, res) => {
  const row = db.prepare(`
    SELECT b.*, c.name customer_name, c.mobile, v.name vehicle_name, v.vehicle_number,
           d.name driver_name, d.mobile driver_mobile
    FROM bookings b
    JOIN customers c ON c.id=b.customer_id
    LEFT JOIN vehicles v ON v.id=b.vehicle_id
    LEFT JOIN drivers d ON d.id=b.driver_id
    WHERE b.booking_id=?
  `).get(req.params.bookingId);
  if (!row) return res.status(404).json({ error: 'Booking not found' });
  res.json(row);
});

const EDITABLE_STATUSES = ['PENDING', 'CONFIRMED'];

// ---------- customer: edit own booking (mobile-verified) ----------
app.patch('/api/bookings/:bookingId', (req, res) => {
  const b = req.body || {};
  const row = db.prepare(`
    SELECT bk.*, c.mobile customer_mobile FROM bookings bk
    JOIN customers c ON c.id=bk.customer_id WHERE bk.booking_id=?
  `).get(req.params.bookingId);
  if (!row) return res.status(404).json({ error: 'Booking not found' });
  if (!b.mobile || String(b.mobile).trim() !== row.customer_mobile)
    return res.status(403).json({ error: 'Mobile number does not match this booking' });
  if (!EDITABLE_STATUSES.includes(row.status))
    return res.status(400).json({ error: `Booking is ${row.status.replaceAll('_', ' ')} and can no longer be edited` });

  const pickup = b.pickup || row.pickup_location;
  const drop = b.drop || row.drop_location;
  const date = b.date || row.journey_date;
  const time = b.time || row.journey_time;
  const passengers = b.passengers ? Number(b.passengers) : row.passengers;
  if (isPastDate(date)) return res.status(400).json({ error: 'Journey date cannot be in the past' });

  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id=?').get(row.vehicle_id);
  if (vehicle && passengers > vehicle.seating_capacity)
    return res.status(400).json({ error: `${vehicle.name} seats only ${vehicle.seating_capacity} passengers` });
  if (vehicle) {
    const conflict = findVehicleConflict(vehicle.id, date, time, row.id);
    if (conflict) return res.status(409).json({ error: `${vehicle.name} is already booked around that time on ${date}. Please pick another time.` });
  }

  db.prepare(`UPDATE bookings SET pickup_location=?,drop_location=?,journey_date=?,journey_time=?,passengers=?,
    additional_requirements=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(pickup, drop, date, time, passengers, b.requirements ?? row.additional_requirements, row.id);
  res.json({ ok: true });
});

// ---------- customer: cancel own booking (mobile-verified) ----------
app.patch('/api/bookings/:bookingId/cancel', (req, res) => {
  const b = req.body || {};
  const row = db.prepare(`
    SELECT bk.*, c.mobile customer_mobile FROM bookings bk
    JOIN customers c ON c.id=bk.customer_id WHERE bk.booking_id=?
  `).get(req.params.bookingId);
  if (!row) return res.status(404).json({ error: 'Booking not found' });
  if (!b.mobile || String(b.mobile).trim() !== row.customer_mobile)
    return res.status(403).json({ error: 'Mobile number does not match this booking' });
  if (['COMPLETED', 'CANCELLED', 'ON_TRIP'].includes(row.status))
    return res.status(400).json({ error: `Booking is ${row.status.replaceAll('_', ' ')} and cannot be cancelled` });

  db.prepare(`UPDATE bookings SET status='CANCELLED',updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(row.id);
  if (row.driver_id) {
    const driver = db.prepare('SELECT mobile FROM drivers WHERE id=?').get(row.driver_id);
    if (driver) notify(driver.mobile, statusUpdateMsg({ bookingId: row.booking_id, status: 'CANCELLED' }));
  }
  res.json({ ok: true });
});

// ---------- admin: dashboard ----------
app.get('/api/admin/dashboard', adminOnly, (req, res) => {
  const statuses = ['PENDING', 'CONFIRMED', 'DRIVER_ASSIGNED', 'ON_TRIP', 'COMPLETED', 'CANCELLED'];
  const counts = {};
  for (const s of statuses) counts[s] = db.prepare('SELECT COUNT(*) c FROM bookings WHERE status=?').get(s).c;
  counts.TOTAL = db.prepare('SELECT COUNT(*) c FROM bookings').get().c;
  res.json(counts);
});

// ---------- admin: bookings (with filters) ----------
// Capped at MAX_PAGE_SIZE per request so this can't return an unbounded result
// set as bookings pile up. Pass ?limit=&offset= to page through more.
// Default page size is smaller (DEFAULT_PAGE_SIZE) so the admin UI's
// pagination controls have something to page through; ?limit= can still
// request up to MAX_PAGE_SIZE at once.
const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 50;
app.get('/api/admin/bookings', adminOnly, (req, res) => {
  const { status, q, date } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  let where = ' WHERE 1=1';
  const params = [];
  if (status) { where += ' AND b.status=?'; params.push(status); }
  if (date) { where += ' AND b.journey_date=?'; params.push(date); }
  if (q) {
    where += ' AND (b.booking_id LIKE ? OR c.name LIKE ? OR c.mobile LIKE ?)';
    const like = `%${q}%`; params.push(like, like, like);
  }
  const total = db.prepare(`SELECT COUNT(*) c FROM bookings b JOIN customers c ON c.id=b.customer_id${where}`).get(...params).c;
  const sql = `
    SELECT b.*, c.name customer_name, c.mobile, v.name vehicle_name,
           d.name driver_name
    FROM bookings b JOIN customers c ON c.id=b.customer_id
    LEFT JOIN vehicles v ON v.id=b.vehicle_id
    LEFT JOIN drivers d ON d.id=b.driver_id
    ${where} ORDER BY b.created_at DESC LIMIT ? OFFSET ?`;
  res.set('X-Total-Count', String(total));
  res.set('Access-Control-Expose-Headers', 'X-Total-Count');
  res.json(db.prepare(sql).all(...params, limit, offset));
});

// ---------- admin: export bookings as CSV ----------
function csvEscape(v) {
  let s = v == null ? '' : String(v);
  // Neutralize formula injection: if a spreadsheet app opens this CSV, a field
  // starting with =, +, -, or @ can be interpreted as a formula. Prefix with an
  // apostrophe so it's always treated as plain text.
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
app.get('/api/admin/bookings/export', adminOnly, (req, res) => {
  const { status, q, date } = req.query;
  let sql = `
    SELECT b.booking_id, c.name customer_name, c.mobile, b.pickup_location, b.drop_location,
           b.journey_date, b.journey_time, v.name vehicle_name, d.name driver_name,
           b.passengers, b.estimated_fare, b.status
    FROM bookings b JOIN customers c ON c.id=b.customer_id
    LEFT JOIN vehicles v ON v.id=b.vehicle_id
    LEFT JOIN drivers d ON d.id=b.driver_id
    WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND b.status=?'; params.push(status); }
  if (date) { sql += ' AND b.journey_date=?'; params.push(date); }
  if (q) { sql += ' AND (b.booking_id LIKE ? OR c.name LIKE ? OR c.mobile LIKE ?)'; const like = `%${q}%`; params.push(like, like, like); }
  sql += ' ORDER BY b.created_at DESC';
  const rows = db.prepare(sql).all(...params);

  const headers = ['Booking ID', 'Customer', 'Mobile', 'Pickup', 'Drop', 'Date', 'Time', 'Vehicle', 'Driver', 'Passengers', 'Fare', 'Status'];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([r.booking_id, r.customer_name, r.mobile, r.pickup_location, r.drop_location,
      r.journey_date, r.journey_time, r.vehicle_name, r.driver_name, r.passengers, r.estimated_fare, r.status]
      .map(csvEscape).join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="velan-bookings-${todayForFilename()}.csv"`);
  res.send(lines.join('\n'));
});
function todayForFilename() { return new Date().toISOString().slice(0, 10); }

// ---------- admin: analytics (revenue, top routes, top vehicles) ----------
app.get('/api/admin/analytics', adminOnly, (req, res) => {
  // Revenue by month — last 6 months, based on completed trips' journey date.
  const revenueByMonth = db.prepare(`
    SELECT strftime('%Y-%m', journey_date) AS month,
           SUM(estimated_fare) AS revenue,
           COUNT(*) AS trips
    FROM bookings
    WHERE status='COMPLETED' AND journey_date >= date('now', '-6 months')
    GROUP BY month
    ORDER BY month ASC
  `).all();

  // Top routes by booking count (any status, all-time).
  const topRoutes = db.prepare(`
    SELECT pickup_location, drop_location, COUNT(*) AS trips,
           SUM(CASE WHEN status='COMPLETED' THEN estimated_fare ELSE 0 END) AS revenue
    FROM bookings
    GROUP BY pickup_location, drop_location
    ORDER BY trips DESC
    LIMIT 5
  `).all();

  // Top vehicles by completed trip count and revenue.
  const topVehicles = db.prepare(`
    SELECT v.id, v.name, v.vehicle_number,
           COUNT(b.id) AS trips,
           SUM(CASE WHEN b.status='COMPLETED' THEN b.estimated_fare ELSE 0 END) AS revenue
    FROM vehicles v
    LEFT JOIN bookings b ON b.vehicle_id = v.id AND b.status NOT IN ('CANCELLED')
    GROUP BY v.id
    ORDER BY trips DESC
    LIMIT 5
  `).all();

  const totals = db.prepare(`
    SELECT COUNT(*) AS completedTrips,
           COALESCE(SUM(estimated_fare),0) AS totalRevenue,
           COALESCE(AVG(estimated_fare),0) AS avgFare
    FROM bookings WHERE status='COMPLETED'
  `).get();

  res.json({ revenueByMonth, topRoutes, topVehicles, totals });
});

// ---------- admin: customers (with trip counts & total spend) ----------
app.get('/api/admin/customers', adminOnly, (req, res) => {
  const { q } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  let where = ' WHERE 1=1';
  const params = [];
  if (q) { where += ' AND (c.name LIKE ? OR c.mobile LIKE ?)'; const like = `%${q}%`; params.push(like, like); }
  const total = db.prepare(`SELECT COUNT(*) c FROM customers c${where}`).get(...params).c;
  const sql = `
    SELECT c.id, c.name, c.mobile, c.created_at,
           COUNT(b.id) AS total_trips,
           COALESCE(SUM(CASE WHEN b.status='COMPLETED' THEN b.estimated_fare ELSE 0 END),0) AS total_spend,
           MAX(b.created_at) AS last_booking
    FROM customers c
    LEFT JOIN bookings b ON b.customer_id = c.id
    ${where} GROUP BY c.id ORDER BY last_booking DESC LIMIT ? OFFSET ?`;
  res.set('X-Total-Count', String(total));
  res.set('Access-Control-Expose-Headers', 'X-Total-Count');
  res.json(db.prepare(sql).all(...params, limit, offset));
});

// ---------- admin: recent activity feed (last status/driver changes) ----------
app.get('/api/admin/activity', adminOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT b.booking_id, b.status, b.pickup_location, b.drop_location, b.updated_at, b.created_at
    FROM bookings b
    ORDER BY b.updated_at DESC
    LIMIT 8
  `).all();
  res.json(rows);
});

// ---------- admin: change own password ----------
app.patch('/api/admin/settings/password', adminOnly, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const admin = db.prepare('SELECT * FROM admins WHERE email=?').get(req.adminEmail);
  if (!admin || !verifyPassword(currentPassword || '', admin.password_hash))
    return res.status(401).json({ error: 'Current password is incorrect' });
  if (!newPassword || newPassword.length < 6)
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  db.prepare('UPDATE admins SET password_hash=? WHERE id=?').run(hashPassword(newPassword), admin.id);
  // Revoke every admin session after a password change so an old token cannot
  // remain valid if it was copied or left active on another device.
  db.prepare("DELETE FROM sessions WHERE kind='admin'").run();
  res.json({ ok: true });
});

app.patch('/api/admin/bookings/:id/status', adminOnly, (req, res) => {
  const allowed = ['PENDING', 'CONFIRMED', 'DRIVER_ASSIGNED', 'ON_TRIP', 'COMPLETED', 'CANCELLED'];
  if (!allowed.includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE bookings SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(req.body.status, req.params.id);
  const row = db.prepare(`
    SELECT b.booking_id, c.mobile FROM bookings b JOIN customers c ON c.id=b.customer_id WHERE b.id=?
  `).get(req.params.id);
  if (row) notify(row.mobile, statusUpdateMsg({ bookingId: row.booking_id, status: req.body.status }));
  res.json({ ok: true });
});

app.patch('/api/admin/bookings/:id/driver', adminOnly, (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id=?').get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const driverId = req.body.driverId || null;
  if (driverId) {
    const conflict = findDriverConflict(driverId, booking.journey_date, booking.journey_time, booking.id);
    if (conflict) {
      const driver = db.prepare('SELECT name FROM drivers WHERE id=?').get(driverId);
      return res.status(409).json({ error: `${driver ? driver.name : 'This driver'} is already assigned to another trip around that time on ${booking.journey_date}.` });
    }
  }
  db.prepare("UPDATE bookings SET driver_id=?,status='DRIVER_ASSIGNED',updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(driverId, req.params.id);
  if (driverId) {
    const driver = db.prepare('SELECT name, mobile FROM drivers WHERE id=?').get(driverId);
    const customer = db.prepare('SELECT name, mobile FROM customers WHERE id=?').get(booking.customer_id);
    if (driver) {
      notify(driver.mobile, tripAssignedDriverMsg({
        bookingId: booking.booking_id, pickup: booking.pickup_location, drop: booking.drop_location,
        date: booking.journey_date, time: booking.journey_time,
        customerName: customer ? customer.name : '', customerMobile: customer ? customer.mobile : '',
      }));
      if (customer) {
        notify(customer.mobile, driverAssignedCustomerMsg({ bookingId: booking.booking_id, driverName: driver.name, driverMobile: driver.mobile }));
      }
    }
  }
  res.json({ ok: true });
});

// ---------- admin: vehicles ----------
app.post('/api/admin/vehicles', adminOnly, (req, res) => {
  const { name, vehicleNumber, seatingCapacity, baseFare, ratePerKm, ac, fuelType } = req.body;
  if (!name || !vehicleNumber || !seatingCapacity)
    return res.status(400).json({ error: 'Name, number and seating capacity are required' });
  try {
    const r = db.prepare('INSERT INTO vehicles(name,vehicle_number,seating_capacity,base_fare,rate_per_km,ac,fuel_type) VALUES(?,?,?,?,?,?,?)')
      .run(name, vehicleNumber, Number(seatingCapacity), Number(baseFare) || 0, Number(ratePerKm) || 0,
        (ac === 'true' || ac === true || ac === '1' || ac === 1) ? 1 : 0, fuelType || 'Diesel');
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'Vehicle number already exists' });
  }
});
app.patch('/api/admin/vehicles/:id', adminOnly, (req, res) => {
  const { name, vehicleNumber, seatingCapacity, baseFare, ratePerKm, ac, fuelType, status } = req.body;
  db.prepare(`UPDATE vehicles SET name=?,vehicle_number=?,seating_capacity=?,base_fare=?,rate_per_km=?,ac=?,fuel_type=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(name, vehicleNumber, Number(seatingCapacity), Number(baseFare) || 0, Number(ratePerKm) || 0,
      (ac === 'true' || ac === true || ac === '1' || ac === 1) ? 1 : 0, fuelType || 'Diesel', status, req.params.id);
  res.json({ ok: true });
});

// ---------- admin: drivers ----------
app.post('/api/admin/drivers', adminOnly, (req, res) => {
  const { name, mobile, vehicleId, pin } = req.body;
  if (!name || !mobile) return res.status(400).json({ error: 'Name and mobile are required' });
  if (!isValidMobile(mobile)) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });
  if (!isValidPin(pin)) return res.status(400).json({ error: 'PIN must be 4–6 digits' });
  const r = db.prepare('INSERT INTO drivers(name,mobile,vehicle_id,pin_hash) VALUES(?,?,?,?)')
    .run(name, mobile, vehicleId || null, hashPin(pin));
  res.status(201).json({ id: r.lastInsertRowid });
});
app.patch('/api/admin/drivers/:id', adminOnly, (req, res) => {
  const { name, mobile, vehicleId, status, pin } = req.body;
  // PIN is optional on edit — only touch it if the admin actually typed a new one.
  if (pin && !isValidPin(pin)) return res.status(400).json({ error: 'PIN must be 4–6 digits' });
  if (pin) {
    db.prepare(`UPDATE drivers SET name=?,mobile=?,vehicle_id=?,status=?,pin_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(name, mobile, vehicleId || null, status, hashPin(pin), req.params.id);
  } else {
    db.prepare(`UPDATE drivers SET name=?,mobile=?,vehicle_id=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(name, mobile, vehicleId || null, status, req.params.id);
  }
  res.json({ ok: true });
});

// ---------- admin: database backup (no schema/data mutation) ----------
app.get('/api/admin/backup', adminOnly, (req, res) => {
  if (!fs.existsSync(dbPath)) return res.status(404).json({ error: 'Database file not found' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="velan-travels-backup-${new Date().toISOString().slice(0,10)}.db"`);
  const checkpoint = db.pragma('wal_checkpoint(PASSIVE)');
  return res.sendFile(dbPath, { dotfiles: 'deny' }, err => { if (err && !res.headersSent) res.status(500).json({ error: 'Backup failed' }); });
});

// Do not leak stack traces or internal errors to clients.
app.use((err, req, res, next) => {
  if (err?.message === 'CORS origin not allowed') return res.status(403).json({ error: 'Origin not allowed' });
  console.error('[server]', err?.message || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/index.html'));
});

app.listen(PORT, () => console.log(`Velan Travels running at http://localhost:${PORT}`));
