// ---------- SMS / WhatsApp notifications (Twilio) ----------
// Sends booking confirmations and status updates to customers and drivers.
// Fully optional: if Twilio credentials aren't set (or NOTIFY_CHANNEL=off),
// every call just logs to the console instead of sending — so the rest of
// the app keeps working untouched in dev / before you've set up an account.

let twilio;
try { twilio = require('twilio'); } catch (e) { twilio = null; }

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_SMS_FROM,        // e.g. +14155550100 (a Twilio phone number, SMS-enabled)
  TWILIO_WHATSAPP_FROM,   // e.g. whatsapp:+14155238886 (Twilio sandbox or approved WA sender)
  NOTIFY_CHANNEL = 'sms', // 'sms' | 'whatsapp' | 'both' | 'off'
  NOTIFY_COUNTRY_CODE = '+91',
} = process.env;

const configured = !!(twilio && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN);
const client = configured ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

if (NOTIFY_CHANNEL !== 'off' && !configured) {
  console.log('[notify] Twilio not configured (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN missing) — ' +
    'SMS/WhatsApp notifications will be logged to console instead of sent. See README for setup.');
}

function toE164(mobile) {
  const s = String(mobile || '').trim();
  if (!s) return s;
  return s.startsWith('+') ? s : `${NOTIFY_COUNTRY_CODE}${s}`;
}

function channelsFor(setting) {
  if (setting === 'both') return ['sms', 'whatsapp'];
  if (setting === 'whatsapp') return ['whatsapp'];
  if (setting === 'off') return [];
  return ['sms'];
}

async function sendOne(channel, toMobile, body) {
  const to = toE164(toMobile);
  if (!to) return;
  if (!configured) {
    console.log(`[notify:${channel}] (Twilio not configured, not sent) -> ${to}: ${body}`);
    return;
  }
  try {
    if (channel === 'sms') {
      if (!TWILIO_SMS_FROM) return console.warn('[notify] TWILIO_SMS_FROM not set — skipping SMS to', to);
      await client.messages.create({ from: TWILIO_SMS_FROM, to, body });
    } else if (channel === 'whatsapp') {
      if (!TWILIO_WHATSAPP_FROM) return console.warn('[notify] TWILIO_WHATSAPP_FROM not set — skipping WhatsApp to', to);
      await client.messages.create({ from: TWILIO_WHATSAPP_FROM, to: `whatsapp:${to}`, body });
    }
  } catch (e) {
    // A notification failure should never break a booking or status update.
    console.error(`[notify:${channel}] send failed for ${to}:`, e.message);
  }
}

// Fire-and-forget: callers don't need to await this, and one bad number/
// Twilio error never blocks or fails the underlying API request.
function notify(toMobile, body) {
  for (const channel of channelsFor(NOTIFY_CHANNEL)) {
    sendOne(channel, toMobile, body);
  }
}

// ---------- message templates ----------
const STATUS_LABELS = {
  PENDING: 'received and pending confirmation',
  CONFIRMED: 'confirmed',
  DRIVER_ASSIGNED: 'assigned a driver',
  ON_TRIP: 'now on trip',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

function bookingConfirmedMsg({ bookingId, pickup, drop, date, time, fare }) {
  return `Velan Travels: Booking ${bookingId} received for ${pickup} to ${drop} on ${date} ${time}.` +
    (fare ? ` Estimated fare Rs.${fare}.` : '') +
    ` We'll update you on confirmation.`;
}

function statusUpdateMsg({ bookingId, status }) {
  return `Velan Travels: Booking ${bookingId} is ${STATUS_LABELS[status] || status.toLowerCase()}.`;
}

function driverAssignedCustomerMsg({ bookingId, driverName, driverMobile }) {
  return `Velan Travels: Driver ${driverName} (${driverMobile}) has been assigned to your booking ${bookingId}.`;
}

function tripAssignedDriverMsg({ bookingId, pickup, drop, date, time, customerName, customerMobile }) {
  return `Velan Travels: New trip ${bookingId} assigned to you. ${pickup} to ${drop} on ${date} ${time}. ` +
    `Customer: ${customerName} (${customerMobile}).`;
}

// ---------- OTP delivery (customer login) ----------
// Unlike notify() above, this ignores NOTIFY_CHANNEL — an OTP is on the
// critical path of logging in (not an FYI update), so it always tries SMS
// even if the site is configured for WhatsApp-only or notifications are off.
// With no Twilio credentials it still just logs to the console, same as
// every other message in this file, so login works untouched in dev.
async function sendOtp(mobile, otp) {
  const body = `Velan Travels: Your OTP is ${otp}. It expires in 5 minutes. Do not share this with anyone.`;
  await sendOne('sms', mobile, body);
}

module.exports = {
  notify,
  sendOtp,
  bookingConfirmedMsg,
  statusUpdateMsg,
  driverAssignedCustomerMsg,
  tripAssignedDriverMsg,
};
