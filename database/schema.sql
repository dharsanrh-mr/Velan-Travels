PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  mobile TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  vehicle_number TEXT UNIQUE NOT NULL,
  seating_capacity INTEGER NOT NULL,
  base_fare REAL NOT NULL DEFAULT 0,
  rate_per_km REAL NOT NULL DEFAULT 0,
  ac INTEGER NOT NULL DEFAULT 1,
  fuel_type TEXT NOT NULL DEFAULT 'Diesel',
  status TEXT NOT NULL DEFAULT 'AVAILABLE',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS drivers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  mobile TEXT NOT NULL,
  pin_hash TEXT,
  vehicle_id INTEGER,
  status TEXT NOT NULL DEFAULT 'AVAILABLE',
  pin_is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL
);

-- DB-backed sessions: survive server restarts and work across multiple
-- server instances (unlike the old in-memory Map).
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL,          -- 'admin' | 'driver'
  subject TEXT NOT NULL,       -- admin email, or driver id (as text)
  expires_at INTEGER NOT NULL  -- epoch ms
);

-- One-time-passwords for customer mobile-number login. Short-lived (5 min)
-- and hashed at rest, same as passwords/PINs. A row is deleted as soon as
-- it's used or superseded by a fresh request for the same mobile.
CREATE TABLE IF NOT EXISTS otps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mobile TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT UNIQUE NOT NULL,
  customer_id INTEGER NOT NULL,
  pickup_location TEXT NOT NULL,
  drop_location TEXT NOT NULL,
  journey_date TEXT NOT NULL,
  journey_time TEXT NOT NULL,
  vehicle_id INTEGER,
  driver_id INTEGER,
  passengers INTEGER NOT NULL,
  additional_requirements TEXT,
  estimated_distance_km REAL,
  estimated_fare REAL,
  discount_amount REAL NOT NULL DEFAULT 0,
  promo_code TEXT,
  referral_code TEXT,
  payment_status TEXT NOT NULL DEFAULT 'UNPAID',
  payment_order_id TEXT,
  payment_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY(vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL,
  FOREIGN KEY(driver_id) REFERENCES drivers(id) ON DELETE SET NULL
);


-- Immutable booking timeline for customer/admin visibility.
CREATE TABLE IF NOT EXISTS booking_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(booking_id) REFERENCES bookings(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_booking_events_booking ON booking_events(booking_id, created_at);


-- Future-ready business, tracking, feedback and maintenance tables.
CREATE TABLE IF NOT EXISTS promo_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, discount_type TEXT NOT NULL DEFAULT 'PERCENT',
  discount_value REAL NOT NULL DEFAULT 0, max_discount REAL, min_fare REAL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS booking_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id INTEGER UNIQUE NOT NULL, rating INTEGER NOT NULL, review TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(booking_id) REFERENCES bookings(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS driver_locations (
  driver_id INTEGER PRIMARY KEY, latitude REAL NOT NULL, longitude REAL NOT NULL, accuracy REAL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(driver_id) REFERENCES drivers(id) ON DELETE CASCADE
);
-- Compatibility tables for the operations/admin UI.
CREATE TABLE IF NOT EXISTS maintenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT, vehicle_id INTEGER NOT NULL, maintenance_type TEXT NOT NULL,
  service_date TEXT, odometer_km REAL, notes TEXT, next_due_date TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, type TEXT NOT NULL DEFAULT 'PERCENT',
  value REAL NOT NULL DEFAULT 0, min_fare REAL DEFAULT 0, max_discount REAL, usage_limit INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0, expires_at TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_maintenance_due ON maintenance(next_due_date);
CREATE INDEX IF NOT EXISTS idx_coupon_code ON coupons(code);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor_type TEXT NOT NULL, actor TEXT, action TEXT NOT NULL, entity_type TEXT, entity_id TEXT,
  details TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_promo_code ON promo_codes(code);
CREATE INDEX IF NOT EXISTS idx_maintenance_vehicle ON maintenance(vehicle_id, next_due_date);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);



CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, referrer_mobile TEXT NOT NULL, referral_code TEXT UNIQUE NOT NULL,
  referred_mobile TEXT, reward_amount REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
