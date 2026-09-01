const app = document.getElementById('app');
let token = localStorage.getItem('vt_token') || '';
let bookingCache = {};

const api = async (url, opt = {}) => {
  opt.headers = { ...(opt.headers || {}), 'Content-Type': 'application/json' };
  if (token) opt.headers.Authorization = 'Bearer ' + token;
  const r = await fetch(url, opt);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(d.error || 'Request failed');
  return d;
};
// Same as api(), but also reads the X-Total-Count header (used by paginated
// admin list endpoints) so callers can build page controls.
const apiPaged = async (url, opt = {}) => {
  opt.headers = { ...(opt.headers || {}), 'Content-Type': 'application/json' };
  if (token) opt.headers.Authorization = 'Bearer ' + token;
  const r = await fetch(url, opt);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(d.error || 'Request failed');
  const total = Number(r.headers.get('X-Total-Count'));
  return { rows: d, total: Number.isFinite(total) ? total : d.length };
};
const PAGE_SIZE = 50;
// Renders "‹ Prev  Page 2 of 5 (73 total)  Next ›" — onPage(newOffset) is
// called when the user clicks a still-enabled button.
function paginationBar(offset, total, pageSize, onPageId) {
  if (total <= pageSize) return '';
  const page = Math.floor(offset / pageSize) + 1;
  const pages = Math.ceil(total / pageSize);
  const prevOffset = Math.max(0, offset - pageSize);
  const nextOffset = offset + pageSize;
  return `<div class="pagination-bar" style="display:flex;align-items:center;justify-content:center;gap:14px;margin-top:14px;font-size:13px;color:var(--muted)">
    <button type="button" class="btn secondary" id="${onPageId}Prev" ${offset === 0 ? 'disabled' : ''} data-offset="${prevOffset}" style="padding:6px 14px">‹ Prev</button>
    <span>Page ${page} of ${pages} (${total} total)</span>
    <button type="button" class="btn secondary" id="${onPageId}Next" ${nextOffset >= total ? 'disabled' : ''} data-offset="${nextOffset}" style="padding:6px 14px">Next ›</button>
  </div>`;
}
const todayStr = () => new Date().toISOString().slice(0, 10);
const money = n => n == null ? '-' : '₹' + Number(n).toLocaleString('en-IN');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- UI feedback / motion helpers ----------
function ensureToastRegion() {
  let region = document.getElementById('vtToastRegion');
  if (!region) {
    region = document.createElement('div');
    region.id = 'vtToastRegion';
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'true');
    document.body.appendChild(region);
  }
  return region;
}
function toast(message, type = 'success', timeout = 3200) {
  if (!message) return;
  const region = ensureToastRegion();
  const item = document.createElement('div');
  item.className = `vt-toast ${type}`;
  const icon = type === 'error' ? '!' : type === 'warning' ? '!' : '✓';
  item.innerHTML = `<span class="vt-toast-icon">${icon}</span><div class="vt-toast-body">${esc(message)}</div><button class="vt-toast-close" aria-label="Dismiss">×</button>`;
  const remove = () => { item.style.opacity = '0'; item.style.transform = 'translateY(8px)'; setTimeout(() => item.remove(), 180); };
  item.querySelector('.vt-toast-close').onclick = remove;
  region.appendChild(item);
  if (timeout > 0) setTimeout(remove, timeout);
}
function setButtonBusy(btn, busy, busyText = 'Please wait…') {
  if (!btn) return;
  if (busy) {
    btn.dataset.originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="vt-spinner" aria-hidden="true"></span>${busyText}`;
  } else if (btn.dataset.originalText) {
    btn.disabled = false;
    btn.innerHTML = btn.dataset.originalText;
    delete btn.dataset.originalText;
  }
}
function initReveal() {
  const els = document.querySelectorAll('.card,.section,.grid > .card,.stats-row > .stat-card,.table-wrap');
  if (!('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver(entries => entries.forEach(entry => {
    if (entry.isIntersecting) { entry.target.classList.add('vt-visible'); io.unobserve(entry.target); }
  }), { threshold: .08 });
  els.forEach((el, i) => { el.classList.add('vt-reveal'); el.style.transitionDelay = `${Math.min(i * 25, 180)}ms`; io.observe(el); });
}

// ---------------- Google Maps: auto distance calc (optional) ----------------
// Loads config once, lazily injects the Places script only if a browser key
// is configured, and hooks up autocomplete + auto distance-fill on the
// booking wizard's pickup/drop fields. Degrades to the old manual "approx.
// distance" entry if no key is set or a lookup fails.
let mapsConfigPromise = null;
function getMapsConfig() {
  if (!mapsConfigPromise) mapsConfigPromise = api('/api/config').catch(() => ({ mapsBrowserKey: '', mapsEnabled: false }));
  return mapsConfigPromise;
}
let mapsScriptPromise = null;
function loadGoogleMapsScript(key) {
  if (mapsScriptPromise) return mapsScriptPromise;
  mapsScriptPromise = new Promise((resolve, reject) => {
    if (window.google?.maps?.places) return resolve();
    window.__vtMapsReady = () => resolve();
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places&callback=__vtMapsReady`;
    s.onerror = () => reject(new Error('Failed to load Google Maps'));
    document.head.appendChild(s);
  });
  return mapsScriptPromise;
}

// Wires Places Autocomplete onto the given pickup/drop <input> elements and
// calls onDistance(distanceKm, durationText) once both are set and the
// backend distance lookup succeeds. Silently no-ops if Maps isn't configured.
async function initRouteAutocomplete(pickupEl, dropEl, onDistance, onStatus) {
  const cfg = await getMapsConfig();
  if (!cfg.mapsEnabled || !cfg.mapsBrowserKey) return;
  try {
    await loadGoogleMapsScript(cfg.mapsBrowserKey);
  } catch (e) {
    console.warn('[maps]', e.message);
    return;
  }
  const g = window.google;
  const pickupAc = new g.maps.places.Autocomplete(pickupEl, { fields: ['formatted_address'] });
  const dropAc = new g.maps.places.Autocomplete(dropEl, { fields: ['formatted_address'] });

  const tryCalc = async () => {
    const pickup = pickupEl.value.trim();
    const drop = dropEl.value.trim();
    if (!pickup || !drop) return;
    onStatus?.('loading');
    try {
      const r = await api(`/api/distance?pickup=${encodeURIComponent(pickup)}&drop=${encodeURIComponent(drop)}`);
      onDistance(r.distanceKm, r.durationText);
      onStatus?.('ok', r);
    } catch (e) {
      onStatus?.('error', e.message);
    }
  };
  pickupAc.addListener('place_changed', tryCalc);
  dropAc.addListener('place_changed', tryCalc);
}

// ---------------- Driver session (separate from admin token) ----------------
let driverToken = '';
let driverName = '';
const driverApi = async (url, opt = {}) => {
  opt.headers = { ...(opt.headers || {}), 'Content-Type': 'application/json' };
  if (driverToken) opt.headers.Authorization = 'Bearer ' + driverToken;
  const r = await fetch(url, opt);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(d.error || 'Request failed');
  return d;
};

// ---------------- Customer session (mobile + OTP, separate from admin/driver) ----------------
// Persisted (unlike the driver token) so a repeat customer isn't asked to
// OTP-login again every time they close the browser.
let customerToken = localStorage.getItem('vt_customer_token') || '';
let customerMobile = localStorage.getItem('vt_customer_mobile') || '';
let customerName = localStorage.getItem('vt_customer_name') || '';
const customerApi = async (url, opt = {}) => {
  opt.headers = { ...(opt.headers || {}), 'Content-Type': 'application/json' };
  if (customerToken) opt.headers.Authorization = 'Bearer ' + customerToken;
  const r = await fetch(url, opt);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(d.error || 'Request failed');
  return d;
};
function customerLogout() {
  customerApi('/api/customer/logout', { method: 'POST' }).catch(() => {});
  customerToken = ''; customerMobile = ''; customerName = '';
  localStorage.removeItem('vt_customer_token');
  localStorage.removeItem('vt_customer_mobile');
  localStorage.removeItem('vt_customer_name');
}

// ---------------- Admin: CSV export ----------------
async function exportBookingsCsv(filters = {}) {
  const qs = new URLSearchParams(filters).toString();
  const r = await fetch('/api/admin/bookings/export' + (qs ? '?' + qs : ''), {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!r.ok) return;
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `velan-bookings-${todayStr()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ---------------- Icons ----------------
const ICON = {
  car: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 13l1.5-4.5A2 2 0 0 1 6.4 7h11.2a2 2 0 0 1 1.9 1.5L21 13"/><rect x="2.5" y="13" width="19" height="5.5" rx="1.5"/><circle cx="7" cy="18.5" r="1.5"/><circle cx="17" cy="18.5" r="1.5"/></svg>',
  check: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>',
  shield: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2l8 4v6c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6l8-4z"/></svg>',
  seat: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 4h6a2 2 0 0 1 2 2v6H6z"/><path d="M6 12v6a2 2 0 0 0 2 2h8"/><path d="M14 12h4a2 2 0 0 1 2 2v6"/></svg>',
  clock: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
  heart: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s-7-4.4-9.5-8.8C.7 8.6 2.4 5 6 5c2 0 3.4 1.1 6 3.6C14.6 6.1 16 5 18 5c3.6 0 5.3 3.6 3.5 7.2C19 16.6 12 21 12 21z"/></svg>',
  phone: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.5 21 3 13.5 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .8-.2 1L6.6 10.8z"/></svg>',
  dash: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></svg>',
  book: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5"/></svg>',
  truck: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="6" width="13" height="10" rx="1.5"/><path d="M15 10h4l3 3v3h-7z"/><circle cx="6.5" cy="18" r="1.6"/><circle cx="17.5" cy="18" r="1.6"/></svg>',
  user: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 5-6 8-6s6.5 2 8 6"/></svg>',
  logout: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>',
  chart: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20V10M12 20V4M20 20v-7"/></svg>',
  bell: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  users: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1.2-3.5 3.8-5.5 6.5-5.5s5.3 2 6.5 5.5"/><path d="M16 8.2a3.2 3.2 0 1 1 0 6.4"/><path d="M18.5 14.7c2 .6 3.4 2.3 4 5.3"/></svg>',
  gear: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 13.5a1.7 1.7 0 0 0 .3 1.9l.1.1a2.1 2.1 0 1 1-3 3l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V20a2.1 2.1 0 1 1-4.2 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2.1 2.1 0 1 1-3-3l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H2a2.1 2.1 0 1 1 0-4.2h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2.1 2.1 0 1 1 3-3l.1.1a1.7 1.7 0 0 0 1.9.3H8.3a1.7 1.7 0 0 0 1-1.5V2a2.1 2.1 0 1 1 4.2 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2.1 2.1 0 1 1 3 3l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H22a2.1 2.1 0 1 1 0 4.2h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  eye: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>',
};

// ---------------- App shell ----------------
function shell(content, { admin = false, activeNav = '' } = {}) {
  app.innerHTML = `<header>
    <div class="brand"><div class="logo-mark">V</div><div>VELAN<span style="color:var(--orange)"> TRAVELS</span><small>SAFE · RELIABLE · ALWAYS WITH YOU</small></div></div>
    <button class="nav-toggle" id="navToggle" aria-label="Menu">☰</button>
    <nav id="nav">${admin
      ? `<a href="#dashboard">Dashboard</a><a href="#analytics">Analytics</a><a href="#bookings">Bookings</a><a href="#vehicles">Vehicles</a><a href="#drivers">Drivers</a><a href="#logout">Logout</a>`
      : `<a href="#" data-scroll="top">Home</a><a href="#" data-scroll="about">About Us</a><a href="#" data-scroll="services">Services</a><a href="#" data-scroll="contact">Contact Us</a>
         <a class="phone-btn" href="tel:+919655213027">${ICON.phone} +91 96552 13027</a>`}</nav>
  </header>
  <main>${content}</main>
  <footer>
    <div class="wrap" style="text-align:left;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:20px;padding-bottom:16px">
      <div><b style="color:#fff">VELAN TRAVELS</b><p style="margin-top:8px;font-size:12.5px">Safe, reliable and always with you — for every journey, big or small.</p></div>
      <div><b style="color:#fff">Customers</b><p style="margin-top:8px"><a href="#book" style="display:block;padding:3px 0">Book a Trip</a><a href="#status" style="display:block;padding:3px 0">Check Booking Status</a><a href="#faq" style="display:block;padding:3px 0">FAQ</a><a href="#my-bookings" style="display:block;padding:3px 0">My Bookings</a></p></div>
      <div><b style="color:#fff">Partners</b><p style="margin-top:8px"><a href="#driver" style="display:block;padding:3px 0">Driver Login</a><a href="#admin" style="display:block;padding:3px 0">Admin Login</a></p></div>
      <div><b style="color:#fff">Contact</b><p style="margin-top:8px;font-size:12.5px">+91 96552 13027<br>info@velantravels.com</p></div>
    </div>
    <div style="border-top:1px solid rgba(255,255,255,.12);padding-top:14px">© ${new Date().getFullYear()} Velan Travels · Safe • Reliable • Always With You</div>
  </footer>`;
  const toggle = document.getElementById('navToggle');
  const nav = document.getElementById('nav');
  if (toggle) toggle.onclick = () => nav.classList.toggle('open');
  nav.querySelectorAll('a').forEach(a => {
    if (a.dataset.scroll) a.onclick = e => { e.preventDefault(); goHomeScroll(a.dataset.scroll); };
    if (a.getAttribute('href') === '#' + activeNav) a.classList.add('active');
    a.onclick = a.onclick || (() => nav.classList.remove('open'));
  });
  nav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => nav.classList.remove('open')));
  requestAnimationFrame(initReveal);
}
function loading(admin = false) { shell('<p class="loading">Loading…</p>', { admin }); }

function goHomeScroll(id) {
  if (location.hash && location.hash !== '#') { location.hash = ''; setTimeout(() => scrollToId(id), 60); }
  else scrollToId(id);
}
function scrollToId(id) {
  if (id === 'top') return window.scrollTo({ top: 0, behavior: 'smooth' });
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------- Home ----------------
function home() {
  shell(`
  <section class="hero hero-premium" id="topSection">
    <div class="hero-overlay"></div>
    <div class="hero-content">
      <div class="hero-copy">
        <span class="hero-kicker">PREMIUM TRAVEL • LOCAL & OUTSTATION</span>
        <h1>Your Journey,<br><span>Our Priority.</span></h1>
        <p>Safe, comfortable and on-time travel with professionally maintained vehicles and trusted drivers.</p>
        <div class="hero-actions">
          <a class="btn hero-primary" href="#book">Book Your Trip <span>→</span></a>
          <a class="hero-call" href="tel:+919655213027">${ICON.phone} <span>+91 96552 13027</span></a>
        </div>
        <div class="hero-badges hero-badges-premium">
          <div class="hero-badge"><span class="ic">${ICON.shield}</span><span>Safe</span></div>
          <div class="hero-badge"><span class="ic">${ICON.seat}</span><span>Comfort</span></div>
          <div class="hero-badge"><span class="ic">${ICON.clock}</span><span>On Time</span></div>
          <div class="hero-badge"><span class="ic">${ICON.heart}</span><span>Trusted</span></div>
        </div>
      </div>

      <div class="hero-booking card">
        <div class="booking-badge">QUICK BOOKING</div>
        <h2>Plan your next trip</h2>
        <p class="booking-sub">Get started in a few simple steps.</p>
        <form id="qbfHero" class="field-grid" style="margin-top:16px">
          <div class="field"><label>Pickup Location</label><input name="pickup" placeholder="Where are you starting?" required></div>
          <div class="field"><label>Drop Location</label><input name="drop" placeholder="Where are you going?" required></div>
          <div class="field"><label>Date</label><input type="date" name="date" min="${todayStr()}" required></div>
          <div class="field"><label>Time</label><input type="time" name="time" required></div>
        </form>
        <button form="qbfHero" class="btn block hero-book-btn">Search Available Vehicles <span>→</span></button>
        <div class="booking-note">✓ Instant enquiry &nbsp; • &nbsp; ✓ No hidden charges</div>
      </div>
    </div>
    <div class="hero-bottom-wave"></div>
  </section>

  <div class="two-col">
    <div class="card quick-book">
      <h2>Book Your Trip</h2>
      <form id="qbf" class="field-grid" style="margin-top:14px">
        <div class="field"><label>Pickup Location</label><input name="pickup" placeholder="Enter pickup location" required></div>
        <div class="field"><label>Drop Location</label><input name="drop" placeholder="Enter drop location" required></div>
        <div class="field"><label>Date</label><input type="date" name="date" min="${todayStr()}" required></div>
        <div class="field"><label>Time</label><input type="time" name="time" required></div>
      </form>
      <button form="qbf" class="btn block" style="margin-top:6px">Search Vehicle</button>
    </div>
    <div class="card">
      <h2>Why Choose Velan Travels?</h2>
      <ul class="why-list">
        <li><span class="tick">${ICON.check}</span>Well Maintained Vehicles</li>
        <li><span class="tick">${ICON.check}</span>Professional Drivers</li>
        <li><span class="tick">${ICON.check}</span>On Time Guarantee</li>
        <li><span class="tick">${ICON.check}</span>24/7 Customer Support</li>
      </ul>
    </div>
  </div>

  <section class="section" id="services">
    <h2 style="text-align:center;font-size:26px">Our Services</h2>
    <p style="text-align:center;color:var(--muted)">A ride for every kind of journey</p>
  </section>
  <div class="grid">
    <div class="card"><h3>Outstation Trips</h3><p>Comfortable long-distance journeys with well-maintained vehicles.</p></div>
    <div class="card"><h3>Airport Transfer</h3><p>On-time pickup and drop, every time.</p></div>
    <div class="card"><h3>Corporate Travel</h3><p>Reliable, professional travel for teams and businesses.</p></div>
  </div>

  <section class="section" id="about" style="padding-top:0">
    <div class="two-col" style="grid-template-columns:1fr;margin-top:0">
      <div class="card">
        <h2>About Us</h2>
        <p style="color:var(--muted)">Velan Travels has been offering safe, reliable and comfortable travel services with well-maintained vehicles and professional, experienced drivers — always on time, always with you.</p>
      </div>
    </div>
  </section>
  <section class="section" id="faq" style="padding-top:0">
    <div class="card" style="max-width:1136px;margin:0 auto">
      <h2>Frequently Asked Questions</h2>
      <details><summary>Can I cancel or reschedule?</summary><p>You can edit eligible bookings or cancel them from Check Booking Status.</p></details>
      <details><summary>Will I get the driver's details?</summary><p>Once a driver is assigned, their name and contact details appear in your booking status.</p></details>
      <details><summary>Can I track my driver?</summary><p>Yes. During an active assigned trip, use Live Driver from the booking status page when the driver is sharing location.</p></details>
    </div>
  </section>
  <section class="section" id="contact" style="padding-top:0">
    <div class="card" style="max-width:1136px;margin:0 auto">
      <h2>Contact Us</h2>
      <p style="color:var(--muted)">${ICON.phone} &nbsp;+91 96552 13027 &nbsp;·&nbsp; info@velantravels.com</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px"><a class="btn" href="https://wa.me/919655213027" target="_blank" rel="noopener">WhatsApp Support</a><a class="btn secondary" href="https://www.google.com/search?q=Velan+Travels+reviews" target="_blank" rel="noopener">Leave a Google Review</a></div>
    </div>
  </section>
  `, { activeNav: '' });

  const startBooking = e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    wz = { pickup: f.pickup, drop: f.drop, date: f.date, time: f.time };
    wzStep = 1;
    location.hash = 'book';
  };
  document.querySelectorAll('#qbfHero, #qbf').forEach(form => form.onsubmit = startBooking);
  initReveal();
}

// ---------------- Customer: Booking Wizard ----------------
let wz = {};      // pickup, drop, date, time, distanceKm, vehicleId, name, mobile, passengers, requirements
let wzStep = 1;
let wzResult = null;
let wzVehicles = [];

const WZ_STEPS = [
  { n: 1, label: 'Route & Date' },
  { n: 2, label: 'Vehicle' },
  { n: 3, label: 'Details' },
  { n: 4, label: 'Confirm' },
];

function wizardProgress() {
  return `<div class="wizard-steps">${WZ_STEPS.map(s => `
    <div class="wizard-step ${s.n < wzStep ? 'done' : ''} ${s.n === wzStep ? 'active' : ''}">
      <div class="circle">${s.n < wzStep ? ICON.check : s.n}</div>
      <div class="label">${s.label}</div>
    </div>`).join('')}</div>`;
}

function tripSummaryCard() {
  return `<div class="card summary-card">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h2 style="margin:0">Trip Details</h2>
      <button type="button" class="btn secondary" id="editRoute" style="padding:6px 12px;font-size:12.5px">Edit</button>
    </div>
    <div class="row"><span>Pickup</span><b>${esc(wz.pickup)}</b></div>
    <div class="row"><span>Drop</span><b>${esc(wz.drop)}</b></div>
    <div class="row"><span>Date</span><b>${esc(wz.date)}</b></div>
    <div class="row"><span>Time</span><b>${esc(wz.time)}</b></div>
  </div>`;
}

async function booking() {
  if (!wzStep) wzStep = 1;
  if (wzStep === 1) return renderWizardStep1();
  if (wzStep === 2) return renderWizardStep2();
  if (wzStep === 3) return renderWizardStep3();
  if (wzStep === 4) return renderWizardStep4();
}

function renderWizardStep1() {
  shell(`<section class="page">
    <h1 style="text-align:center">Book Your Trip</h1>
    ${wizardProgress()}
    <div class="wizard-body">
      <div class="card">
        <h2>Route &amp; Date</h2>
        <form id="s1" style="display:flex;flex-direction:column;gap:14px;margin-top:10px">
          <div class="field"><label>Pickup Location</label><input name="pickup" value="${esc(wz.pickup || '')}" placeholder="Enter pickup location" required></div>
          <div class="field"><label>Drop Location</label><input name="drop" value="${esc(wz.drop || '')}" placeholder="Enter drop location" required></div>
          <div class="quick-book field-grid" style="margin-bottom:0">
            <div class="field"><label>Date</label><input type="date" name="date" min="${todayStr()}" value="${esc(wz.date || '')}" required></div>
            <div class="field"><label>Time</label><input type="time" name="time" value="${esc(wz.time || '')}" required></div>
          </div>
          <div class="field">
            <label>Distance (km) — used for the fare estimate</label>
            <input type="number" min="0" name="distanceKm" id="distanceKmInput" value="${esc(wz.distanceKm || '')}" placeholder="e.g. 120">
            <p id="distanceStatus" style="font-size:11.5px;color:var(--muted);margin:4px 0 0">Enter pickup &amp; drop above to auto-calculate, or type it in yourself.</p>
          </div>
        </form>
      </div>
    </div>
    <div class="wizard-nav" style="justify-content:flex-end">
      <button form="s1" class="btn">Continue</button>
    </div>
  </section>`);
  document.getElementById('s1').onsubmit = e => {
    e.preventDefault();
    Object.assign(wz, Object.fromEntries(new FormData(e.target)));
    wzStep = 2;
    booking();
  };

  const distanceInput = document.getElementById('distanceKmInput');
  const statusEl = document.getElementById('distanceStatus');
  initRouteAutocomplete(
    document.querySelector('#s1 input[name="pickup"]'),
    document.querySelector('#s1 input[name="drop"]'),
    (km, durationText) => { distanceInput.value = km; },
    (state, data) => {
      if (!statusEl) return;
      if (state === 'loading') statusEl.textContent = 'Calculating distance…';
      else if (state === 'ok') statusEl.textContent = `Auto-calculated: ${data.distanceKm} km (~${data.durationText} drive) — you can edit this if needed.`;
      else if (state === 'error') statusEl.textContent = 'Could not auto-calculate — please enter the distance manually.';
    }
  );
}

async function renderWizardStep2() {
  loading();
  wzVehicles = await api('/api/vehicles');
  shell(`<section class="page">
    <h1 style="text-align:center">Book Your Trip</h1>
    ${wizardProgress()}
    <div class="wizard-body with-summary">
      ${tripSummaryCard()}
      <div class="card">
        <h2>Select Vehicle</h2>
        <div class="vehicle-list" id="vList" style="margin-top:12px">
          ${wzVehicles.map(v => `<div class="vehicle-card ${v.status !== 'AVAILABLE' ? 'unavailable' : ''} ${wz.vehicleId == v.id ? 'selected' : ''}" data-id="${v.id}">
            <div class="v-icon">${ICON.car}</div>
            <div class="v-info">
              <h3>${esc(v.name)}</h3>
              <div class="meta"><span>${ICON.seat} ${v.seating_capacity} Seats</span><span>${v.ac ? 'AC' : 'Non-AC'}</span><span>${esc(v.fuel_type || 'Diesel')}</span>${v.status !== 'AVAILABLE' ? '<span style="color:var(--danger)">Unavailable</span>' : ''}</div>
            </div>
            <div class="v-price"><b>${money(v.rate_per_km)}</b><span>/km + ${money(v.base_fare)} base</span></div>
            <div class="check">${ICON.check}</div>
          </div>`).join('') || '<p class="empty">No vehicles available right now.</p>'}
        </div>
      </div>
    </div>
    <div class="wizard-nav">
      <button class="btn secondary" id="backBtn">Back</button>
      <button class="btn" id="continueBtn" ${wz.vehicleId ? '' : 'disabled'}>Continue</button>
    </div>
  </section>`);

  document.getElementById('editRoute').onclick = () => { wzStep = 1; booking(); };
  document.getElementById('backBtn').onclick = () => { wzStep = 1; booking(); };
  const continueBtn = document.getElementById('continueBtn');
  document.getElementById('vList').querySelectorAll('.vehicle-card').forEach(card => {
    card.onclick = () => {
      if (card.classList.contains('unavailable')) return;
      wz.vehicleId = card.dataset.id;
      renderWizardStep2();
    };
  });
  continueBtn.onclick = () => { if (wz.vehicleId) { wzStep = 3; booking(); } };
}

function estimateFare() {
  const v = wzVehicles.find(x => String(x.id) === String(wz.vehicleId));
  if (!v || !wz.distanceKm) return null;
  return Math.round(Number(v.base_fare) + Number(wz.distanceKm) * Number(v.rate_per_km));
}

async function renderWizardStep3() {
  if (!wzVehicles.length) wzVehicles = await api('/api/vehicles');
  const v = wzVehicles.find(x => String(x.id) === String(wz.vehicleId));
  const fare = estimateFare();
  shell(`<section class="page">
    <h1 style="text-align:center">Book Your Trip</h1>
    ${wizardProgress()}
    <div class="wizard-body with-summary">
      <div class="card">
        <h2>Customer Details</h2>
        <form id="s3" style="display:flex;flex-direction:column;gap:14px;margin-top:10px">
          <div class="field"><label>Full Name</label><input name="name" value="${esc(wz.name || '')}" placeholder="Enter your name" required></div>
          <div class="field"><label>Phone Number</label><input name="mobile" value="${esc(wz.mobile || '')}" placeholder="10-digit mobile number" pattern="[6-9][0-9]{9}" required></div>
          <div class="field"><label>No. of Passengers</label><input type="number" min="1" name="passengers" value="${esc(wz.passengers || '')}" placeholder="Number of passengers" required></div>
          <div class="field"><label>Promo Code (optional)</label><div style="display:flex;gap:8px"><input name="promoCode" value="${esc(wz.promoCode || '')}" placeholder="SAVE10" style="flex:1"><button type="button" class="btn secondary" id="promoBtn">Apply</button></div><small id="promoMsg" style="color:var(--muted)"></small></div>
          <div class="field"><label>Additional Notes (optional)</label><textarea name="requirements" placeholder="Any special requests">${esc(wz.requirements || '')}</textarea></div>
          <p id="s3err" class="error"></p>
        </form>
      </div>
      <div class="card summary-card">
        <h2>Booking Summary</h2>
        <div class="row"><span>From</span><b>${esc(wz.pickup)}</b></div>
        <div class="row"><span>To</span><b>${esc(wz.drop)}</b></div>
        <div class="row"><span>Date &amp; Time</span><b>${esc(wz.date)}, ${esc(wz.time)}</b></div>
        <div class="row"><span>Vehicle</span><b>${v ? esc(v.name) : '-'}</b></div>
        <div class="fare-row"><span>Estimated Fare</span><span class="amt">${fare ? money(fare) : 'Add distance to estimate'}</span></div>
        <p style="font-size:11.5px;color:var(--muted);margin-top:6px">*Fare may vary based on traffic and other factors.</p>
      </div>
    </div>
    <div class="wizard-nav">
      <button class="btn secondary" id="backBtn">Back</button>
      <button form="s3" class="btn" id="confirmBtn">Confirm Booking</button>
    </div>
  </section>`);

  document.getElementById('backBtn').onclick = () => { wzStep = 2; booking(); };
  document.getElementById('s3').onsubmit = async e => {
    e.preventDefault();
    Object.assign(wz, Object.fromEntries(new FormData(e.target)));
    const btn = document.getElementById('confirmBtn');
    btn.disabled = true; btn.textContent = 'Booking…';
    try {
      const r = await api('/api/bookings', { method: 'POST', body: JSON.stringify(wz) });
      wzResult = r;
      wzStep = 4;
      toast('Booking submitted successfully. Confirmation details are ready.');
      booking();
    } catch (x) {
      document.getElementById('s3err').textContent = x.message;
      btn.disabled = false; btn.textContent = 'Confirm Booking';
    }
  };
  document.getElementById('promoBtn').onclick = async () => {
    const code = document.querySelector('[name=promoCode]').value.trim();
    const msg = document.getElementById('promoMsg'); if (!code) { msg.textContent='Enter a promo code'; return; }
    try { const r = await api(`/api/promos/validate?code=${encodeURIComponent(code)}&fare=${encodeURIComponent(fare || 0)}`); wz.promoCode = r.code; msg.style.color='var(--green)'; msg.textContent=`Applied: ${money(r.amount)} off`; } catch(e) { msg.style.color='var(--danger)'; msg.textContent=e.message; }
  };
}

function renderWizardStep4() {
  shell(`<section class="page">
    <h1 style="text-align:center">Book Your Trip</h1>
    ${wizardProgress()}
    <div class="wizard-body" style="max-width:520px">
      <div class="card confirm-box">
        <div class="tick-circle">${ICON.check}</div>
        <h2>Booking Confirmed!</h2>
        <p style="color:var(--muted)">Your trip has been booked successfully.</p>
        <div class="bid">
          <span style="font-size:12px;color:var(--muted)">Booking ID</span>
          <span class="id">${esc(wzResult.bookingId)}</span>
        </div>
        ${wzResult.estimatedFare ? `<p style="margin-top:12px">Estimated Fare: <b>${money(wzResult.estimatedFare)}</b></p>` : ''}
        <p style="font-size:12.5px;color:var(--muted);margin-top:6px">You will receive a confirmation SMS shortly.</p>
        <div class="actions">
          <button class="btn secondary" id="viewBtn">View Booking</button>
          <button class="btn" id="homeBtn">Go to Home</button>
        </div>
      </div>
    </div>
  </section>`);
  document.getElementById('homeBtn').onclick = () => { wz = {}; wzStep = 1; wzResult = null; location.hash = ''; };
  document.getElementById('viewBtn').onclick = () => {
    const id = wzResult.bookingId;
    wz = {}; wzStep = 1; wzResult = null;
    location.hash = 'status';
    setTimeout(() => loadBookingCard(id), 50);
  };
}

// ---------------- Customer: Status ----------------
const EDITABLE_STATUSES = ['PENDING', 'CONFIRMED'];
const CANCELLABLE_STATUSES = ['PENDING', 'CONFIRMED', 'DRIVER_ASSIGNED'];

// Set by myBookings() when the customer taps a booking from their history,
// so status() can jump straight to that booking's card instead of making
// them retype the Booking ID.
let pendingStatusLookup = null;

function status() {
  shell(`<section class="page narrow">
    <h1>Check Booking Status</h1>
    <p style="color:var(--muted)">Enter your Booking ID to view your trip details.</p>
    <form id="sf" class="form-inline" style="margin-top:14px">
      <input name="id" placeholder="e.g. VT8A24F1C" value="${esc(pendingStatusLookup || '')}" style="flex:1;border:1.5px solid var(--border);border-radius:9px;padding:11px 12px" required>
      <button class="btn">Check</button>
    </form>
    <div id="sr" style="margin-top:20px"></div>
  </section>`);
  document.getElementById('sf').onsubmit = async e => {
    e.preventDefault();
    const id = new FormData(e.target).get('id').trim();
    await loadBookingCard(id);
  };
  if (pendingStatusLookup) {
    const id = pendingStatusLookup;
    pendingStatusLookup = null;
    loadBookingCard(id);
  }
}

function statusTimeline(current) {
  const steps = [
    ['PENDING','Booking Received'],['CONFIRMED','Confirmed'],['DRIVER_ASSIGNED','Driver Assigned'],['ON_TRIP','On Trip'],['COMPLETED','Completed']
  ];
  const order = Object.fromEntries(steps.map((x,i)=>[x[0],i]));
  const active = order[current] ?? -1;
  if (current === 'CANCELLED') return `<div class="vt-timeline cancelled"><div class="vt-timeline-title">Booking Cancelled</div><div class="vt-timeline-line"><span class="done"></span><span class="cancel-dot">×</span></div><small>The booking is no longer active.</small></div>`;
  return `<div class="vt-timeline"><div class="vt-timeline-title">Trip Progress</div><div class="vt-timeline-track">${steps.map((x,i)=>`<div class="vt-step ${i<active?'done':''} ${i===active?'current':''}"><span>${i<active?'✓':i===active?'•':i+1}</span><small>${x[1]}</small></div>`).join('')}</div></div>`;
}

async function startRazorpayPayment(bookingId) {
  try {
    const cfg=await customerApi('/api/customer/payments/config');
    if(!cfg.enabled) { toast('Online payment is not configured yet.','warning'); return; }
    if(!window.Razorpay) {
      await new Promise((resolve,reject)=>{
        const s=document.createElement('script'); s.src='https://checkout.razorpay.com/v1/checkout.js';
        s.onload=resolve; s.onerror=()=>reject(new Error('Payment checkout could not load')); document.head.appendChild(s);
      });
    }
    const order=await customerApi('/api/customer/payments/order',{method:'POST',body:JSON.stringify({bookingId})});
    const rzp=new Razorpay({
      key:order.keyId, amount:order.amount, currency:order.currency, name:'Velan Travels',
      description:`Booking ${bookingId}`, order_id:order.orderId,
      handler:async response=>{
        try {
          await customerApi('/api/customer/payments/verify',{method:'POST',body:JSON.stringify({bookingId,...response})});
          toast('Payment successful ✓');
          loadBookingCard(bookingId);
        } catch(e) { toast(e.message,'error'); }
      },
      theme:{color:'#075536'}
    });
    rzp.on('payment.failed',()=>toast('Payment was not completed. You can try again.','warning'));
    rzp.open();
  } catch(e) { toast(e.message,'error'); }
}

async function loadBookingCard(id) {
  const sr = document.getElementById('sr');
  if (!sr) return;
  sr.innerHTML = '<p class="loading">Loading…</p>';
  try {
    const r = await api('/api/bookings/' + id);
    const canEdit = EDITABLE_STATUSES.includes(r.status);
    const canCancel = CANCELLABLE_STATUSES.includes(r.status);
    sr.innerHTML = `<div class="card" id="printArea">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0">${esc(r.booking_id)}</h2>
        <span class="status-pill status-${r.status}">${r.status.replaceAll('_', ' ')}</span>
      </div>
      ${statusTimeline(r.status)}
      <div class="summary-card" style="margin-top:10px">
        <div class="row"><span>Customer</span><b>${esc(r.customer_name)} · ${esc(r.mobile)}</b></div>
        <div class="row"><span>Route</span><b>${esc(r.pickup_location)} → ${esc(r.drop_location)}</b></div>
        <div class="row"><span>Date &amp; Time</span><b>${esc(r.journey_date)} · ${esc(r.journey_time)}</b></div>
        <div class="row"><span>Passengers</span><b>${r.passengers}</b></div>
        ${r.vehicle_name ? `<div class="row"><span>Vehicle</span><b>${esc(r.vehicle_name)}</b></div>` : ''}
        ${r.driver_name ? `<div class="row"><span>Driver</span><b>${esc(r.driver_name)} · ${esc(r.driver_mobile)}</b></div>` : ''}${r.driver_latitude != null && r.driver_longitude != null ? `<div class="row"><span>Live Location</span><a class="btn secondary" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${r.driver_latitude},${r.driver_longitude}">View Driver Location</a></div>` : ''}
        ${r.estimated_fare ? `<div class="row"><span>Estimated Fare</span><b>${money(r.estimated_fare)}</b></div>` : ''}
      </div>
      <div class="no-print">
        <button class="btn secondary" onclick="window.print()">Print / Save PDF</button>
        ${canEdit ? `<button class="btn secondary" id="editBtn">Edit Booking</button>` : ''}
        ${canCancel ? `<button class="btn danger" id="cancelBtn">Cancel Booking</button>` : ''}
        ${r.driver_name && ['DRIVER_ASSIGNED','ON_TRIP'].includes(r.status) ? `<button class="btn secondary" id="trackBtn">Live Driver</button>` : ''}
        ${r.status === 'COMPLETED' ? `<button class="btn secondary" id="rateBtn">Rate Trip</button>` : ''}
        ${r.estimated_fare && r.payment_status !== 'PAID' && r.status !== 'CANCELLED' ? `<button class="btn" id="payBtn">Pay ${money(r.estimated_fare)}</button>` : ''}
        ${r.payment_status === 'PAID' ? `<span class="status-pill status-CONFIRMED">PAID</span>` : ''}
        <button class="btn secondary" id="waShareBtn">Share on WhatsApp</button>
      </div>
      <div id="liveArea"></div>
      <div id="editArea"></div>
    </div>`;
    const editBtn = document.getElementById('editBtn');
    if (editBtn) editBtn.onclick = () => showEditForm(r);
    const cancelBtn = document.getElementById('cancelBtn');
    if (cancelBtn) cancelBtn.onclick = () => showCancelConfirm(r);
    const trackBtn=document.getElementById('trackBtn'); if(trackBtn) trackBtn.onclick=()=>startLiveTracking(r.booking_id);
    const rateBtn=document.getElementById('rateBtn'); if(rateBtn) rateBtn.onclick=()=>showRatingForm(r.booking_id);
    const payBtn=document.getElementById('payBtn'); if(payBtn) payBtn.onclick=()=>startRazorpayPayment(r.booking_id);
    const waBtn=document.getElementById('waShareBtn'); if(waBtn) waBtn.onclick=()=>{
      const text=`Velan Travels Booking ${r.booking_id}\n${r.pickup_location} → ${r.drop_location}\n${r.journey_date} ${r.journey_time}\nStatus: ${String(r.status).replaceAll('_',' ')}`;
      window.open('https://wa.me/?text='+encodeURIComponent(text),'_blank','noopener');
    };
  } catch (x) {
    sr.innerHTML = `<p class="error">${esc(x.message)}</p>`;
  }
}

function startLiveTracking(bookingId) {
  const area=document.getElementById('liveArea'); if(!area) return;
  let timer=null;
  const poll=async()=>{ try { const r=await api(`/api/bookings/${encodeURIComponent(bookingId)}/live`); if(r.latitude==null){ area.innerHTML='<div class="card" style="margin-top:12px"><b>Live Driver Tracking</b><p style="color:var(--muted)">Driver location is not available yet.</p></div>'; return; } const maps=`https://www.google.com/maps/search/?api=1&query=${r.latitude},${r.longitude}`; area.innerHTML=`<div class="card" style="margin-top:12px"><b>Live Driver Tracking</b><p style="margin:6px 0">${esc(r.driver_name||'Driver')} · Updated ${esc(r.updated_at||'now')}</p><a class="btn secondary" target="_blank" rel="noopener" href="${maps}">Open Driver Location</a></div>`; } catch(e){} };
  poll(); timer=setInterval(poll,15000); setTimeout(()=>clearInterval(timer),10*60*1000);
}
function showRatingForm(bookingId){
  const area=document.getElementById('liveArea'); if(!area)return;
  area.innerHTML=`<form id="ratingForm" class="card" style="margin-top:12px"><b>Rate your trip</b><div class="field" style="margin-top:10px"><label>Rating</label><select name="rating"><option value="5">★★★★★</option><option value="4">★★★★☆</option><option value="3">★★★☆☆</option><option value="2">★★☆☆☆</option><option value="1">★☆☆☆☆</option></select></div><div class="field"><label>Review (optional)</label><textarea name="review" maxlength="1000" placeholder="How was your experience?"></textarea></div><button class="btn">Submit Review</button><p id="rateErr" class="error"></p></form>`;
  document.getElementById('ratingForm').onsubmit=async e=>{e.preventDefault();try{await customerApi(`/api/customer/bookings/${encodeURIComponent(bookingId)}/rating`,{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});toast('Thank you for your feedback!');area.innerHTML='<p style="color:var(--green)">Thanks — your review was submitted.</p>';}catch(x){document.getElementById('rateErr').textContent=x.message;}};
}

function showCancelConfirm(r) {
  const area = document.getElementById('editArea');
  area.innerHTML = `<form id="cf" style="margin-top:16px;display:flex;flex-direction:column;gap:12px">
    <p>Enter your mobile number to confirm cancellation of <b>${esc(r.booking_id)}</b>.</p>
    <input name="mobile" placeholder="Mobile Number" style="border:1.5px solid var(--border);border-radius:9px;padding:11px 12px" required>
    <div class="no-print" style="margin-top:0">
      <button class="btn danger">Confirm Cancel</button>
      <button type="button" class="btn secondary" id="backBtn">Back</button>
    </div>
    <p id="cErr" class="error"></p>
  </form>`;
  document.getElementById('backBtn').onclick = () => { area.innerHTML = ''; };
  document.getElementById('cf').onsubmit = async e => {
    e.preventDefault();
    const mobile = new FormData(e.target).get('mobile').trim();
    try {
      await api(`/api/bookings/${r.booking_id}/cancel`, { method: 'PATCH', body: JSON.stringify({ mobile }) });
      await loadBookingCard(r.booking_id);
    } catch (x) {
      document.getElementById('cErr').textContent = x.message;
    }
  };
}

function showEditForm(r) {
  const area = document.getElementById('editArea');
  area.innerHTML = `<form id="ef" style="margin-top:16px;display:flex;flex-direction:column;gap:12px">
    <p>Enter your mobile number to verify, then update your trip details.</p>
    <input name="mobile" placeholder="Mobile Number" style="border:1.5px solid var(--border);border-radius:9px;padding:11px 12px" required>
    <input name="pickup" placeholder="Pickup Location" value="${esc(r.pickup_location)}" style="border:1.5px solid var(--border);border-radius:9px;padding:11px 12px" required>
    <input name="drop" placeholder="Drop Location" value="${esc(r.drop_location)}" style="border:1.5px solid var(--border);border-radius:9px;padding:11px 12px" required>
    <input type="date" name="date" min="${todayStr()}" value="${r.journey_date}" style="border:1.5px solid var(--border);border-radius:9px;padding:11px 12px" required>
    <input type="time" name="time" value="${r.journey_time}" style="border:1.5px solid var(--border);border-radius:9px;padding:11px 12px" required>
    <input type="number" name="passengers" min="1" value="${r.passengers}" style="border:1.5px solid var(--border);border-radius:9px;padding:11px 12px" required>
    <textarea name="requirements" placeholder="Additional Requirements" style="border:1.5px solid var(--border);border-radius:9px;padding:11px 12px">${esc(r.additional_requirements || '')}</textarea>
    <div class="no-print" style="margin-top:0">
      <button class="btn">Save Changes</button>
      <button type="button" class="btn secondary" id="backBtn">Back</button>
    </div>
    <p id="eErr" class="error"></p>
  </form>`;
  document.getElementById('backBtn').onclick = () => { area.innerHTML = ''; };
  document.getElementById('ef').onsubmit = async e => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target));
    try {
      await api(`/api/bookings/${r.booking_id}`, { method: 'PATCH', body: JSON.stringify(b) });
      await loadBookingCard(r.booking_id);
    } catch (x) {
      document.getElementById('eErr').textContent = x.message;
    }
  };
}

// ---------------- Customer: Login (mobile + OTP) ----------------
function customerLogin() {
  if (customerToken) { location.hash = 'my-bookings'; return; }
  shell(`<section class="page narrow">
    <h1>My Bookings</h1>
    <p style="color:var(--muted)">Enter your mobile number to receive a one-time code and view your booking history.</p>
    <form id="clf" class="form-inline" style="margin-top:14px">
      <input name="mobile" placeholder="10-digit mobile number" maxlength="10" style="flex:1;border:1.5px solid var(--border);border-radius:9px;padding:11px 12px" required>
      <button class="btn">Send OTP</button>
    </form>
    <div id="clArea" style="margin-top:16px"></div>
  </section>`, { activeNav: 'my-bookings' });
  document.getElementById('clf').onsubmit = async e => {
    e.preventDefault();
    const mobile = new FormData(e.target).get('mobile').trim();
    const area = document.getElementById('clArea');
    area.innerHTML = '<p class="loading">Sending OTP…</p>';
    try {
      await customerApi('/api/customer/otp/request', { method: 'POST', body: JSON.stringify({ mobile }) });
      showOtpForm(mobile);
    } catch (x) {
      area.innerHTML = `<p class="error">${esc(x.message)}</p>`;
    }
  };
}

function showOtpForm(mobile) {
  const area = document.getElementById('clArea');
  area.innerHTML = `
    <p>OTP sent to <b>${esc(mobile)}</b>. It's valid for 5 minutes.</p>
    <form id="cvf" class="form-inline" style="margin-top:10px">
      <input name="otp" placeholder="6-digit OTP" maxlength="6" style="flex:1;border:1.5px solid var(--border);border-radius:9px;padding:11px 12px" required>
      <button class="btn">Verify</button>
    </form>
    <button type="button" class="btn secondary" id="resendBtn" style="margin-top:10px" disabled>Resend OTP (30s)</button>
    <p id="cvErr" class="error"></p>`;
  const resendBtn = document.getElementById('resendBtn');
  let resendIn = 30;
  const timer = setInterval(() => {
    resendIn--;
    if (resendIn <= 0) {
      clearInterval(timer);
      resendBtn.disabled = false;
      resendBtn.textContent = 'Resend OTP';
    } else {
      resendBtn.textContent = `Resend OTP (${resendIn}s)`;
    }
  }, 1000);
  resendBtn.onclick = async () => {
    resendBtn.disabled = true;
    const errEl = document.getElementById('cvErr');
    try {
      await customerApi('/api/customer/otp/request', { method: 'POST', body: JSON.stringify({ mobile }) });
      errEl.style.color = 'var(--green)';
      errEl.textContent = 'A new OTP has been sent.';
    } catch (x) {
      errEl.style.color = 'var(--danger)';
      errEl.textContent = x.message;
    }
  };
  document.getElementById('cvf').onsubmit = async e => {
    e.preventDefault();
    const otp = new FormData(e.target).get('otp').trim();
    try {
      const r = await customerApi('/api/customer/otp/verify', { method: 'POST', body: JSON.stringify({ mobile, otp }) });
      customerToken = r.token;
      customerMobile = r.customer.mobile;
      customerName = r.customer.name || '';
      localStorage.setItem('vt_customer_token', customerToken);
      localStorage.setItem('vt_customer_mobile', customerMobile);
      localStorage.setItem('vt_customer_name', customerName);
      clearInterval(timer);
      location.hash = 'my-bookings';
    } catch (x) {
      document.getElementById('cvErr').style.color = 'var(--danger)';
      document.getElementById('cvErr').textContent = x.message;
    }
  };
}

// ---------------- Customer: My Bookings (history) ----------------
async function myBookings() {
  if (!customerToken) { location.hash = 'customer-login'; return; }
  loading();
  let rows;
  try {
    rows = await customerApi('/api/customer/bookings');
  } catch (x) {
    // Token missing/expired — send back to login rather than showing an error page.
    customerToken = ''; customerMobile = ''; customerName = '';
    localStorage.removeItem('vt_customer_token');
    localStorage.removeItem('vt_customer_mobile');
    localStorage.removeItem('vt_customer_name');
    location.hash = 'customer-login';
    return;
  }
  shell(`<section class="page">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <h1 style="margin:0">My Bookings${customerName ? ', ' + esc(customerName) : ''}</h1>
      <div style="display:flex;gap:10px">
        <a class="btn secondary" href="#book">Book a Trip</a>
        <button type="button" class="btn secondary" id="clOut">Logout</button>
      </div>
    </div>
    <p style="color:var(--muted)">${esc(customerMobile)}</p><div class="card" style="margin-top:12px;padding:14px"><b>Refer & Earn</b><p style="color:var(--muted);font-size:13px;margin:5px 0">Share your personal referral code with friends.</p><button class="btn secondary" id="refBtn">Get Referral Code</button><span id="refCode" style="margin-left:10px;font-weight:800"></span></div>
    <div id="mbList" style="margin-top:18px;display:flex;flex-direction:column;gap:12px">
      ${rows.length ? rows.map(r => `
        <div class="card mb-item" data-id="${esc(r.booking_id)}" style="cursor:pointer">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
            <b>${esc(r.booking_id)}</b>
            <span class="status-pill status-${r.status}">${r.status.replaceAll('_', ' ')}</span>
          </div>
          <p style="margin:6px 0 0;color:var(--muted)">${esc(r.pickup_location)} → ${esc(r.drop_location)}</p>
          <p style="margin:2px 0 0;color:var(--muted);font-size:13px">${esc(r.journey_date)} · ${esc(r.journey_time)}${r.vehicle_name ? ' · ' + esc(r.vehicle_name) : ''}${r.estimated_fare ? ' · ' + money(r.estimated_fare) : ''}</p>
          <div class="no-print" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
            <button class="btn secondary mb-view" data-id="${esc(r.booking_id)}">View / Track</button>
            <button class="btn secondary mb-receipt" data-id="${esc(r.booking_id)}">Receipt</button>
            ${r.status === 'COMPLETED' ? `<button class="btn mb-review" data-id="${esc(r.booking_id)}">Rate Trip</button>` : ''}
          </div>
        </div>`).join('')
        : '<p style="color:var(--muted)">No bookings found for this mobile number yet.</p>'}
    </div>
  </section>`, { activeNav: 'my-bookings' });
  document.getElementById('clOut').onclick = () => { customerLogout(); location.hash = ''; };
  document.getElementById('refBtn').onclick=async()=>{try{const r=await customerApi('/api/customer/referrals',{method:'POST',body:'{}'});document.getElementById('refCode').textContent=r.code;navigator.clipboard?.writeText(r.code).catch(()=>{});toast('Referral code copied');}catch(e){toast(e.message,'error');}};
  document.querySelectorAll('.mb-view').forEach(el => el.onclick = (e) => { e.stopPropagation(); pendingStatusLookup = el.dataset.id; location.hash = 'status'; });
  document.querySelectorAll('.mb-receipt').forEach(el => el.onclick = async (e) => {
    e.stopPropagation(); try { const r=await customerApi('/api/customer/bookings/'+encodeURIComponent(el.dataset.id)+'/receipt'); printReceipt(r); } catch(x){toast(x.message,'error');}
  });
  document.querySelectorAll('.mb-review').forEach(el => el.onclick = (e) => { e.stopPropagation(); showReviewForm(el.dataset.id); });
  document.querySelectorAll('.mb-item').forEach(el => { el.onclick = () => { pendingStatusLookup = el.dataset.id; location.hash = 'status'; }; });
}

// ---------------- Admin: Login ----------------
function login() {
  shell(`<section class="page narrow">
    <h1>Admin Login</h1>
    <div class="card">
      <form id="lf" style="display:flex;flex-direction:column;gap:14px">
        <div class="field"><label>Email</label><input name="email" type="email" placeholder="admin@velantravels.com" required></div>
        <div class="field"><label>Password</label><input name="password" type="password" placeholder="Password" required></div>
        <button class="btn block">Login</button>
        <p id="le" class="error"></p>
      </form>
    </div>
  </section>`);
  document.getElementById('lf').onsubmit = async e => {
    e.preventDefault();
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
      token = r.token;
      localStorage.setItem('vt_token', token);
      location.hash = 'dashboard';
    } catch (x) {
      document.getElementById('le').textContent = x.message;
    }
  };
}

// ---------------- Admin shell wrapper ----------------
function adminShell(active, title, bodyHtml) {
  shell(`<div class="admin-shell">
    <aside class="sidebar">
      <div class="side-brand"><div class="logo-mark">V</div><b>Velan Travels</b></div>
      <a href="#dashboard" class="${active === 'dashboard' ? 'active' : ''}">${ICON.dash} Dashboard</a>
      <a href="#bookings" class="${active === 'bookings' ? 'active' : ''}">${ICON.book} Bookings</a>
      <a href="#vehicles" class="${active === 'vehicles' ? 'active' : ''}">${ICON.truck} Vehicles</a>
      <a href="#customers" class="${active === 'customers' ? 'active' : ''}">${ICON.users} Customers</a>
      <a href="#drivers" class="${active === 'drivers' ? 'active' : ''}">${ICON.user} Drivers</a>
      <a href="#analytics" class="${active === 'analytics' ? 'active' : ''}">${ICON.chart} Reports</a>
      <a href="#calendar" class="${active === 'calendar' ? 'active' : ''}">${ICON.book} Calendar</a>
      <a href="#maintenance" class="${active === 'maintenance' ? 'active' : ''}">${ICON.gear} Maintenance</a>
      <a href="#promos" class="${active === 'promos' ? 'active' : ''}">${ICON.check} Promos</a>
      <a href="#audit" class="${active === 'audit' ? 'active' : ''}">${ICON.eye} Audit Log</a>
      <a href="#operations" class="${active === 'operations' ? 'active' : ''}">${ICON.truck} Operations</a>
      <a href="#settings" class="${active === 'settings' ? 'active' : ''}">${ICON.gear} Settings</a>
      <a href="#logout" style="margin-top:auto">${ICON.logout} Logout</a>
    </aside>
    <div class="admin-main">
      <div class="admin-topbar">
        <h1>${title}</h1>
        <div class="admin-user">
          <button class="bell-btn" id="adminBell" title="Notifications">${ICON.bell}<span id="adminBellDot" style="display:none;position:absolute;width:8px;height:8px;border-radius:50%;background:var(--danger);top:5px;right:5px"></span></button>
          <div class="avatar">A</div>
          <div class="admin-user-text"><b>Admin</b><small>Administrator</small></div>
        </div>
      </div>
      ${bodyHtml}
    </div>
  </div>`, { admin: true });
}

// ---------------- Admin: Dashboard ----------------
const STATUS_COLORS = {
  PENDING: '#f5a623', CONFIRMED: '#0b5fa8', DRIVER_ASSIGNED: '#6a2fc9',
  ON_TRIP: '#e0900f', COMPLETED: '#1c8a45', CANCELLED: '#c0392b'
};

async function dashboard() {
  loading(true);
  try {
    const [c, recent, activity] = await Promise.all([
      api('/api/admin/dashboard'),
      api('/api/admin/bookings').then(r => r.slice(0, 6)).catch(() => []),
      api('/api/admin/activity').catch(() => [])
    ]);
    bookingCache = {}; recent.forEach(b => bookingCache[b.id] = b);
    const donutStatuses = ['PENDING', 'CONFIRMED', 'DRIVER_ASSIGNED', 'ON_TRIP', 'COMPLETED', 'CANCELLED'];
    const total = c.TOTAL || 0;
    let acc = 0;
    const stops = donutStatuses.map(s => {
      const val = c[s] || 0;
      const pct = total ? (val / total) * 100 : 0;
      const seg = `${STATUS_COLORS[s]} ${acc}% ${acc + pct}%`;
      acc += pct;
      return seg;
    }).join(', ');
    const donutBg = total ? `conic-gradient(${stops})` : '#eee';

    adminShell('dashboard', 'Dashboard', `
      <div class="stats-row">
        <div class="stat-card"><small>Total Bookings</small><b>${c.TOTAL}</b></div>
        <div class="stat-card pending"><small>Pending</small><b>${c.PENDING}</b></div>
        <div class="stat-card completed"><small>Completed</small><b>${c.COMPLETED}</b></div>
        <div class="stat-card cancelled"><small>Cancelled</small><b>${c.CANCELLED}</b></div>
      </div>
      <div class="stats-row" style="margin-top:0">
        <div class="stat-card"><small>Today's Trips</small><b>${c.TODAY || 0}</b></div>
        <div class="stat-card pending"><small>Today's Active</small><b>${c.TODAY_PENDING || 0}</b></div>
        <div class="stat-card completed"><small>Today's Revenue</small><b>${money(c.TODAY_REVENUE || 0)}</b></div>
      </div>
      <div class="dash-grid">
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h2>Recent Bookings</h2><a href="#bookings" style="font-size:12.5px;font-weight:700;color:var(--green)">View All</a>
          </div>
          <div class="table-wrap" style="box-shadow:none;margin-top:10px">
            <table><thead><tr><th>ID</th><th>Customer</th><th>Route</th><th>Date</th><th>Status</th><th></th></tr></thead>
            <tbody>${recent.length ? recent.map(b => `<tr>
              <td>${esc(b.booking_id)}</td>
              <td>${esc(b.customer_name)}</td>
              <td>${esc(b.pickup_location)} → ${esc(b.drop_location)}</td>
              <td>${esc(b.journey_date)}</td>
              <td><span class="status-pill status-${b.status}">${b.status.replaceAll('_', ' ')}</span></td>
              <td><button class="icon-btn" title="View" onclick="showBookingDetail(${b.id})">${ICON.eye}</button></td>
            </tr>`).join('') : '<tr><td colspan="6" class="empty">No bookings yet</td></tr>'}</tbody></table>
          </div>
        </div>
        <div class="card">
          <h2>Booking Status Overview</h2>
          <div class="donut-wrap" style="margin-top:14px">
            <div class="donut" style="background:${donutBg}"></div>
            <div class="donut-legend">${donutStatuses.map(s => `<div class="row"><span><span class="dot" style="background:${STATUS_COLORS[s]}"></span>${s.replaceAll('_', ' ')}</span><b>${c[s]}</b></div>`).join('')}</div>
          </div>
        </div>
      </div>
      <div class="dash-grid">
        <div class="card">
          <h2>Recent Activity</h2>
          <div class="activity-feed">
            ${activity.length ? activity.map(a => `<div class="activity-item">
              <span class="activity-dot status-${a.status}"></span>
              <div>
                <p style="margin:0"><b>${esc(a.booking_id)}</b> — ${esc(a.pickup_location)} → ${esc(a.drop_location)}</p>
                <small style="color:var(--muted)">Status: ${a.status.replaceAll('_', ' ')} · ${timeAgo(a.updated_at)}</small>
              </div>
            </div>`).join('') : '<p class="empty">No activity yet</p>'}
          </div>
        </div>
        <div class="card">
          <h2>Quick Update Status</h2>
          <form id="quickUpdateForm" style="display:flex;flex-direction:column;gap:12px;margin-top:12px">
            <div class="field"><label>Booking ID</label><input name="bookingId" placeholder="e.g. VT1A2B3C4D" required style="text-transform:uppercase"></div>
            <div class="field"><label>Status</label><select name="status">
              ${donutStatuses.map(s => `<option value="${s}">${s.replaceAll('_', ' ')}</option>`).join('')}
            </select></div>
            <button class="btn block">Update Status</button>
            <p id="quickErr" class="error"></p>
          </form>
        </div>
      </div>
      <div class="card">
        <h2>Quick Actions</h2>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">
          <a class="btn" href="#bookings">Manage Bookings</a>
          <a class="btn secondary" href="#analytics">Analytics</a>
          <a class="btn secondary" href="#vehicles">Vehicles</a>
          <a class="btn secondary" href="#drivers">Drivers</a>
        </div>
      </div>
    `);
    document.getElementById('quickUpdateForm').onsubmit = async e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const errEl = document.getElementById('quickErr');
      errEl.textContent = '';
      try {
        const matches = await api('/api/admin/bookings?q=' + encodeURIComponent(f.bookingId.trim()));
        const match = matches.find(b => b.booking_id.toUpperCase() === f.bookingId.trim().toUpperCase());
        if (!match) { errEl.textContent = 'No booking found with that ID'; return; }
        const btn = e.target.querySelector('button[type="submit"]');
        setButtonBusy(btn, true, 'Updating…');
        await api('/api/admin/bookings/' + match.id + '/status', { method: 'PATCH', body: JSON.stringify({ status: f.status }) });
        toast('Booking status updated successfully.');
        dashboard();
      } catch (x) { errEl.textContent = x.message; }
    };
  } catch (e) {
    token = ''; localStorage.removeItem('vt_token'); login();
  }
}
function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso + 'Z').getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min${mins > 1 ? 's' : ''} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs > 1 ? 's' : ''} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}
function showBookingDetail(id) {
  const b = bookingCache[id];
  if (!b) return;
  const rows = [
    ['Booking ID', b.booking_id], ['Customer', b.customer_name], ['Mobile', b.mobile],
    ['Route', `${b.pickup_location} → ${b.drop_location}`], ['Date & Time', `${b.journey_date} ${b.journey_time}`],
    ['Vehicle', b.vehicle_name || '-'], ['Driver', b.driver_name || 'Unassigned'],
    ['Passengers', b.passengers], ['Fare', money(b.estimated_fare)], ['Status', b.status.replaceAll('_', ' ')],
  ];
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box card">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h2 style="margin:0">Booking Details</h2>
      <button class="icon-btn" id="modalClose">✕</button>
    </div>
    <div style="margin-top:14px">${rows.map(r => `<div class="row" style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px dashed var(--border);font-size:14px">
      <span style="color:var(--muted)">${r[0]}</span><b>${esc(String(r[1]))}</b></div>`).join('')}</div>
  </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#modalClose').onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
}

// ---------------- Admin: Analytics ----------------
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function monthLabel(ym) {
  const [y, m] = ym.split('-');
  return `${MONTH_NAMES[Number(m) - 1]} '${y.slice(2)}`;
}
async function analytics() {
  loading(true);
  try {
    const a = await api('/api/admin/analytics');
    const maxRevenue = Math.max(1, ...a.revenueByMonth.map(r => r.revenue || 0));
    const maxRouteTrips = Math.max(1, ...a.topRoutes.map(r => r.trips || 0));
    const maxVehicleTrips = Math.max(1, ...a.topVehicles.map(v => v.trips || 0));

    adminShell('analytics', 'Analytics', `
      <div class="stats-row">
        <div class="stat-card"><small>Total Revenue (Completed)</small><b>${money(a.totals.totalRevenue)}</b></div>
        <div class="stat-card completed"><small>Completed Trips</small><b>${a.totals.completedTrips}</b></div>
        <div class="stat-card"><small>Average Fare</small><b>${money(Math.round(a.totals.avgFare))}</b></div>
      </div>

      <div class="card" style="margin-bottom:18px">
        <h2>Revenue — Last 6 Months</h2>
        ${a.revenueByMonth.length ? `
        <div class="bar-chart">
          ${a.revenueByMonth.map(r => `
            <div class="bar-col">
              <div class="bar-track"><div class="bar-fill" style="height:${Math.round((r.revenue / maxRevenue) * 100)}%" title="${money(r.revenue)}"></div></div>
              <small>${monthLabel(r.month)}</small>
            </div>`).join('')}
        </div>` : '<p class="empty">No completed trips in the last 6 months yet.</p>'}
      </div>

      <div class="dash-grid">
        <div class="card">
          <h2>Top Routes</h2>
          <div class="table-wrap" style="box-shadow:none;margin-top:10px">
            <table><thead><tr><th>Route</th><th>Trips</th><th>Revenue</th></tr></thead>
            <tbody>${a.topRoutes.length ? a.topRoutes.map(r => `<tr>
              <td>${esc(r.pickup_location)} → ${esc(r.drop_location)}</td>
              <td><div class="mini-bar"><div style="width:${Math.round((r.trips / maxRouteTrips) * 100)}%"></div></div>${r.trips}</td>
              <td>${money(r.revenue)}</td>
            </tr>`).join('') : '<tr><td colspan="3" class="empty">No bookings yet</td></tr>'}</tbody></table>
          </div>
        </div>
        <div class="card">
          <h2>Top Vehicles</h2>
          <div class="table-wrap" style="box-shadow:none;margin-top:10px">
            <table><thead><tr><th>Vehicle</th><th>Trips</th><th>Revenue</th></tr></thead>
            <tbody>${a.topVehicles.length ? a.topVehicles.map(v => `<tr>
              <td>${esc(v.name)}<br><span style="color:var(--muted)">${esc(v.vehicle_number)}</span></td>
              <td><div class="mini-bar"><div style="width:${Math.round((v.trips / maxVehicleTrips) * 100)}%"></div></div>${v.trips}</td>
              <td>${money(v.revenue)}</td>
            </tr>`).join('') : '<tr><td colspan="3" class="empty">No vehicles yet</td></tr>'}</tbody></table>
          </div>
        </div>
      </div>
    `);
  } catch (e) {
    token = ''; localStorage.removeItem('vt_token'); login();
  }
}

// ---------------- Admin: Bookings ----------------
async function bookings(filters = {}, offset = 0) {
  loading(true);
  const [{ rows: bs, total }, ds] = await Promise.all([
    apiPaged('/api/admin/bookings?' + new URLSearchParams({ ...filters, limit: PAGE_SIZE, offset })),
    api('/api/drivers')
  ]);
  bs.forEach(b => bookingCache[b.id] = b);
  const statuses = ['PENDING', 'CONFIRMED', 'DRIVER_ASSIGNED', 'ON_TRIP', 'COMPLETED', 'CANCELLED'];
  adminShell('bookings', 'Bookings', `
  <form id="filterForm" class="filter-bar">
    <input name="q" placeholder="Search name / mobile / booking ID" value="${esc(filters.q || '')}" style="flex:1;min-width:200px">
    <select name="status"><option value="">All Statuses</option>${statuses.map(s => `<option ${filters.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
    <input type="date" name="date" value="${filters.date || ''}">
    <button class="btn secondary">Filter</button>
    ${(filters.q || filters.status || filters.date) ? '<button type="button" class="btn secondary" id="clearFilters">Clear</button>' : ''}
    <button type="button" class="btn secondary" id="exportBtn">Export CSV</button>
  </form>
  <div class="table-wrap"><table><thead><tr>
    <th>ID</th><th>Customer</th><th>Route</th><th>Date</th><th>Vehicle</th><th>Fare</th><th>Driver</th><th>Status</th><th>Action</th>
  </tr></thead><tbody>
  ${bs.length ? bs.map(b => `<tr>
    <td>${esc(b.booking_id)}</td>
    <td>${esc(b.customer_name)}<br><span style="color:var(--muted)">${esc(b.mobile)}</span></td>
    <td>${esc(b.pickup_location)} → ${esc(b.drop_location)}</td>
    <td>${esc(b.journey_date)}<br><span style="color:var(--muted)">${esc(b.journey_time)}</span></td>
    <td>${esc(b.vehicle_name || '-')}</td>
    <td>${money(b.estimated_fare)}</td>
    <td><select onchange="assignDriver(${b.id},this.value)">
      <option value="">Unassigned</option>
      ${ds.map(d => `<option value="${d.id}" ${d.id === b.driver_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
    </select></td>
    <td><select onchange="changeStatus(${b.id},this.value)">
      ${statuses.map(s => `<option ${s === b.status ? 'selected' : ''}>${s}</option>`).join('')}
    </select></td>
    <td><button class="icon-btn" title="View" onclick="showBookingDetail(${b.id})">${ICON.eye}</button></td>
  </tr>`).join('') : `<tr><td colspan="9" class="empty">No bookings found</td></tr>`}
  </tbody></table></div>
  ${paginationBar(offset, total, PAGE_SIZE, 'bookings')}`);

  document.getElementById('filterForm').onsubmit = e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    Object.keys(f).forEach(k => { if (!f[k]) delete f[k]; });
    bookings(f, 0);
  };
  const clearBtn = document.getElementById('clearFilters');
  if (clearBtn) clearBtn.onclick = () => bookings({}, 0);
  document.getElementById('exportBtn').onclick = () => exportBookingsCsv(filters);
  const prevBtn = document.getElementById('bookingsPrev'), nextBtn = document.getElementById('bookingsNext');
  if (prevBtn) prevBtn.onclick = () => bookings(filters, Number(prevBtn.dataset.offset));
  if (nextBtn) nextBtn.onclick = () => bookings(filters, Number(nextBtn.dataset.offset));
}
async function changeStatus(id, status) {
  await api('/api/admin/bookings/' + id + '/status', { method: 'PATCH', body: JSON.stringify({ status }) });
}
async function assignDriver(id, driverId) {
  await api('/api/admin/bookings/' + id + '/driver', { method: 'PATCH', body: JSON.stringify({ driverId: driverId || null }) });
}

// ---------------- Admin: Vehicles ----------------
async function vehicles(editId = null) {
  loading(true);
  const vs = await api('/api/vehicles');
  const editing = editId ? vs.find(v => v.id === editId) : null;
  adminShell('vehicles', 'Vehicles', `
  <div class="card">
    <h2>${editing ? 'Edit Vehicle' : 'Add Vehicle'}</h2>
    <form id="vf" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-top:12px">
      <div class="field"><label>Vehicle Name</label><input name="name" placeholder="e.g. Innova Crysta" value="${editing ? esc(editing.name) : ''}" required></div>
      <div class="field"><label>Vehicle Number</label><input name="vehicleNumber" placeholder="TN-XX-XX-XXXX" value="${editing ? esc(editing.vehicle_number) : ''}" required></div>
      <div class="field"><label>Seating Capacity</label><input type="number" name="seatingCapacity" min="1" value="${editing ? editing.seating_capacity : ''}" required></div>
      <div class="field"><label>Base Fare (₹)</label><input type="number" name="baseFare" min="0" value="${editing ? editing.base_fare : ''}"></div>
      <div class="field"><label>Rate per KM (₹)</label><input type="number" name="ratePerKm" min="0" value="${editing ? editing.rate_per_km : ''}"></div>
      <div class="field"><label>Fuel Type</label><select name="fuelType">
        ${['Diesel', 'Petrol', 'CNG', 'Electric'].map(f => `<option ${editing && editing.fuel_type === f ? 'selected' : ''}>${f}</option>`).join('')}
      </select></div>
      <div class="field"><label>AC</label><select name="ac">
        <option value="true" ${!editing || editing.ac ? 'selected' : ''}>AC</option>
        <option value="false" ${editing && !editing.ac ? 'selected' : ''}>Non-AC</option>
      </select></div>
      ${editing ? `<div class="field"><label>Status</label><select name="status"><option ${editing.status === 'AVAILABLE' ? 'selected' : ''}>AVAILABLE</option><option ${editing.status === 'UNAVAILABLE' ? 'selected' : ''}>UNAVAILABLE</option></select></div>` : ''}
      <div style="display:flex;gap:10px;align-items:flex-end">
        <button class="btn">${editing ? 'Save Changes' : 'Add Vehicle'}</button>
        ${editing ? '<button type="button" class="btn secondary" id="cancelEdit">Cancel</button>' : ''}
      </div>
      <p id="vErr" class="error"></p>
    </form>
  </div>
  <div class="grid" style="padding:0;margin-top:18px">${vs.map(v => `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div class="v-icon" style="margin-bottom:8px">${ICON.car}</div>
      <span class="status-pill status-${v.status === 'AVAILABLE' ? 'COMPLETED' : 'CANCELLED'}">${v.status}</span>
    </div>
    <h2>${esc(v.name)}</h2><p style="color:var(--muted)">${esc(v.vehicle_number)}</p>
    <p>${v.seating_capacity} Seats · ${v.ac ? 'AC' : 'Non-AC'} · ${esc(v.fuel_type || 'Diesel')}</p>
    <p>Base ${money(v.base_fare)} + ${money(v.rate_per_km)}/km</p>
    <button class="btn secondary" onclick="vehicles(${v.id})">Edit</button>
  </div>`).join('')}</div>`);

  document.getElementById('vf').onsubmit = async e => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target));
    try {
      if (editing) await api('/api/admin/vehicles/' + editing.id, { method: 'PATCH', body: JSON.stringify(b) });
      else await api('/api/admin/vehicles', { method: 'POST', body: JSON.stringify(b) });
      vehicles();
    } catch (x) { document.getElementById('vErr').textContent = x.message; }
  };
  const cancelBtn = document.getElementById('cancelEdit');
  if (cancelBtn) cancelBtn.onclick = () => vehicles();
}

// ---------------- Admin: Drivers ----------------
async function drivers(editId = null) {
  loading(true);
  const [ds, vs] = await Promise.all([api('/api/drivers'), api('/api/vehicles')]);
  const editing = editId ? ds.find(d => d.id === editId) : null;
  adminShell('drivers', 'Drivers', `
  <div class="card">
    <h2>${editing ? 'Edit Driver' : 'Add Driver'}</h2>
    <form id="df" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-top:12px">
      <div class="field"><label>Driver Name</label><input name="name" value="${editing ? esc(editing.name) : ''}" required></div>
      <div class="field"><label>Mobile Number</label><input name="mobile" pattern="[6-9][0-9]{9}" value="${editing ? esc(editing.mobile) : ''}" required></div>
      <div class="field"><label>${editing ? 'Reset PIN (leave blank to keep current)' : 'PIN (4–6 digits)'}</label><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,6}" placeholder="${editing ? 'Leave blank to keep current' : 'e.g. 1234'}" ${editing ? '' : 'required'}></div>
      <div class="field"><label>Assigned Vehicle</label><select name="vehicleId"><option value="">No vehicle assigned</option>
        ${vs.map(v => `<option value="${v.id}" ${editing && editing.vehicle_id === v.id ? 'selected' : ''}>${esc(v.name)} · ${esc(v.vehicle_number)}</option>`).join('')}
      </select></div>
      ${editing ? `<div class="field"><label>Status</label><select name="status"><option ${editing.status === 'AVAILABLE' ? 'selected' : ''}>AVAILABLE</option><option ${editing.status === 'UNAVAILABLE' ? 'selected' : ''}>UNAVAILABLE</option></select></div>` : ''}
      <div style="display:flex;gap:10px;align-items:flex-end">
        <button class="btn">${editing ? 'Save Changes' : 'Add Driver'}</button>
        ${editing ? '<button type="button" class="btn secondary" id="cancelEdit">Cancel</button>' : ''}
      </div>
      <p id="dErr" class="error"></p>
    </form>
  </div>
  <div class="grid" style="padding:0;margin-top:18px">${ds.map(d => `<div class="card">
    <div class="v-icon" style="margin-bottom:8px">${ICON.user}</div>
    <h2>${esc(d.name)}</h2><p style="color:var(--muted)">${esc(d.mobile)}</p><p>${esc(d.vehicle_name || 'No vehicle assigned')}</p>
    <span class="status-pill status-${d.status === 'AVAILABLE' ? 'COMPLETED' : 'CANCELLED'}">${d.status}</span>
    <div style="margin-top:10px"><button class="btn secondary" onclick="drivers(${d.id})">Edit</button></div>
  </div>`).join('')}</div>`);

  document.getElementById('df').onsubmit = async e => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target));
    try {
      if (editing) await api('/api/admin/drivers/' + editing.id, { method: 'PATCH', body: JSON.stringify(b) });
      else await api('/api/admin/drivers', { method: 'POST', body: JSON.stringify(b) });
      drivers();
    } catch (x) { document.getElementById('dErr').textContent = x.message; }
  };
  const cancelBtn = document.getElementById('cancelEdit');
  if (cancelBtn) cancelBtn.onclick = () => drivers();
}

// ---------------- Driver Portal ----------------
function driverPortal() {
  if (!driverToken) return driverLogin();
  return driverTrips();
}

function driverLogin() {
  shell(`<section class="page narrow">
    <h1>Driver Login</h1>
    <p style="color:var(--muted)">Enter your registered mobile number and PIN to see your assigned trips.</p>
    <div class="card">
      <form id="dlf" style="display:flex;flex-direction:column;gap:14px">
        <div class="field"><label>Mobile Number</label><input name="mobile" placeholder="10-digit mobile number" pattern="[6-9][0-9]{9}" required></div>
        <div class="field"><label>PIN</label><input name="pin" type="password" inputmode="numeric" placeholder="4–6 digit PIN" pattern="[0-9]{4,6}" required></div>
        <button class="btn block">Login</button>
        <p id="dle" class="error"></p>
      </form>
    </div>
  </section>`);
  document.getElementById('dlf').onsubmit = async e => {
    e.preventDefault();
    try {
      const r = await driverApi('/api/driver/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
      driverToken = r.token; driverName = r.driver.name;
      if (r.pinIsDefault) return driverForcePinChange();
      driverTrips();
    } catch (x) {
      document.getElementById('dle').textContent = x.message;
    }
  };
}

// Shown right after login when the driver is still on the auto-assigned
// default PIN (last 4 digits of their mobile) — they must set a real one
// before they can see their trips.
function driverForcePinChange() {
  shell(`<section class="page narrow">
    <h1>Set a New PIN</h1>
    <p style="color:var(--muted)">You're still using the default PIN. Please choose a new 4–6 digit PIN to continue.</p>
    <div class="card">
      <form id="pinf" style="display:flex;flex-direction:column;gap:14px">
        <div class="field"><label>New PIN</label><input name="newPin" type="password" inputmode="numeric" placeholder="4–6 digit PIN" pattern="[0-9]{4,6}" required></div>
        <button class="btn block">Save PIN &amp; Continue</button>
        <p id="pinErr" class="error"></p>
      </form>
    </div>
  </section>`);
  document.getElementById('pinf').onsubmit = async e => {
    e.preventDefault();
    try {
      await driverApi('/api/driver/pin', { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
      driverTrips();
    } catch (x) {
      document.getElementById('pinErr').textContent = x.message;
    }
  };
}

const DRIVER_NEXT_STATUS = { DRIVER_ASSIGNED: 'ON_TRIP', ON_TRIP: 'COMPLETED' };
const DRIVER_NEXT_LABEL = { DRIVER_ASSIGNED: 'Start Trip', ON_TRIP: 'Mark Completed' };

async function driverTrips() {
  loading();
  try {
    const trips = await driverApi('/api/driver/bookings');
    const stats = await driverApi('/api/driver/dashboard').catch(() => ({totalTrips:0,completedTrips:0,todayTrips:0,grossRevenue:0}));
    shell(`<section class="page">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
      <h1 style="margin:0">My Trips${driverName ? ' — ' + esc(driverName) : ''}</h1>
      <div style="display:flex;gap:8px">
        <button class="btn secondary" id="shareLocationBtn">Share Location</button><button class="btn secondary" id="driverChangePinBtn">Change PIN</button>
        <button class="btn secondary" id="driverLogoutBtn">Logout</button>
      </div>
    </div>
    <div class="stats-row" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px"><div class="stat-card"><small>Total Trips</small><b>${stats.totalTrips||0}</b></div><div class="stat-card"><small>Completed</small><b>${stats.completedTrips||0}</b></div><div class="stat-card"><small>Today</small><b>${stats.todayTrips||0}</b></div><div class="stat-card"><small>Gross Revenue</small><b>${money(stats.grossRevenue||0)}</b></div></div>
    <div class="vt-driver-tools"><button class="btn secondary" id="todayTripsBtn">Today</button><button class="btn secondary" id="allTripsBtn">All Trips</button><span id="driverTripCount" class="muted"></span></div>
    <div class="grid" style="padding:0">
    ${trips.length ? trips.map(t => `<div class="card driver-trip-card" data-trip-date="${esc(t.journey_date)}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <h2>${esc(t.booking_id)}</h2>
          <span class="status-pill status-${t.status}">${t.status.replaceAll('_', ' ')}</span>
        </div>
        <p>${esc(t.pickup_location)} → ${esc(t.drop_location)}</p>
        <p style="color:var(--muted)">${esc(t.journey_date)} · ${esc(t.journey_time)}</p>
        <p>${esc(t.customer_name)} · ${esc(t.mobile)}</p>
        <p style="color:var(--muted)">${esc(t.vehicle_name || '-')} · ${t.passengers} passengers</p>
        <div class="trip-actions"><a class="btn secondary" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(t.pickup_location)}">Navigate</a><button class="btn secondary share-location" data-id="${t.id}">Share Location</button>${DRIVER_NEXT_STATUS[t.status] ? `<button class="btn" onclick="updateTripStatus(${t.id})">${DRIVER_NEXT_LABEL[t.status]}</button>` : ''}</div>
      </div>`).join('') : '<p class="empty">No trips assigned yet.</p>'}
    </div></section>`);
    document.getElementById('driverLogoutBtn').onclick = () => {
      driverToken = ''; driverName = ''; location.hash = ''; router();
    };
    const tripCards = [...document.querySelectorAll('.driver-trip-card')];
    const countEl = document.getElementById('driverTripCount');
    const applyTripFilter = (todayOnly) => { const today=todayStr(); let shown=0; tripCards.forEach(c=>{ const show=!todayOnly || c.dataset.tripDate===today; c.style.display=show?'':'none'; if(show) shown++; }); if(countEl) countEl.textContent=`${shown} trip${shown===1?'':'s'} shown`; };
    document.getElementById('todayTripsBtn').onclick=()=>applyTripFilter(true); document.getElementById('allTripsBtn').onclick=()=>applyTripFilter(false); applyTripFilter(false);
    document.querySelectorAll('.share-location').forEach(btn=>btn.onclick=()=>{ if(!navigator.geolocation)return toast('Location is not supported on this device.','error'); navigator.geolocation.getCurrentPosition(async pos=>{try{await driverApi('/api/driver/location',{method:'PATCH',body:JSON.stringify({latitude:pos.coords.latitude,longitude:pos.coords.longitude,accuracy:pos.coords.accuracy})});toast('Live location shared with the booking system.');}catch(x){toast(x.message,'error');}},()=>toast('Please allow location access to share your position.','warning'),{enableHighAccuracy:true,timeout:10000,maximumAge:30000}); });
    document.getElementById('driverChangePinBtn').onclick = () => driverForcePinChange();
    document.getElementById('shareLocationBtn').onclick = () => startDriverLocationSharing();
  } catch (x) {
    driverToken = ''; driverLogin();
  }
}

function startDriverLocationSharing(){
  if(!navigator.geolocation){toast('Location is not supported on this device','error');return;}
  toast('Location sharing started. Keep this page open during trips.');
  const send=pos=>driverApi('/api/driver/location',{method:'PATCH',body:JSON.stringify({latitude:pos.coords.latitude,longitude:pos.coords.longitude,accuracy:pos.coords.accuracy})}).catch(()=>{});
  navigator.geolocation.getCurrentPosition(send,()=>toast('Please allow location access','error'),{enableHighAccuracy:true});
  if(window.__vtWatchId) navigator.geolocation.clearWatch(window.__vtWatchId);
  window.__vtWatchId=navigator.geolocation.watchPosition(send,()=>{}, {enableHighAccuracy:true,maximumAge:10000,timeout:15000});
}

async function updateTripStatus(bookingId) {
  const trips = await driverApi('/api/driver/bookings');
  const t = trips.find(x => x.id === bookingId);
  if (!t) return;
  const next = DRIVER_NEXT_STATUS[t.status];
  if (!next) return;
  try {
    await driverApi(`/api/driver/bookings/${bookingId}/status`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
    toast('Trip status updated successfully.');
    driverTrips();
  } catch (x) { toast(x.message, 'error'); }
}

// ---------------- Admin: Customers ----------------
async function customers(filters = {}, offset = 0) {
  loading(true);
  const { rows: cs, total } = await apiPaged('/api/admin/customers?' + new URLSearchParams({ ...filters, limit: PAGE_SIZE, offset }));
  adminShell('customers', 'Customers', `
  <form id="custFilterForm" class="filter-bar">
    <input name="q" placeholder="Search name / mobile" value="${esc(filters.q || '')}" style="flex:1;min-width:200px">
    <button class="btn secondary">Search</button>
    ${filters.q ? '<button type="button" class="btn secondary" id="clearCustFilter">Clear</button>' : ''}
  </form>
  <div class="table-wrap"><table><thead><tr>
    <th>Name</th><th>Mobile</th><th>Total Trips</th><th>Total Spend</th><th>Customer Since</th>
  </tr></thead><tbody>
  ${cs.length ? cs.map(c => `<tr>
    <td>${esc(c.name)}</td>
    <td>${esc(c.mobile)}</td>
    <td>${c.total_trips}</td>
    <td>${money(c.total_spend)}</td>
    <td>${esc(String(c.created_at || '').slice(0, 10))}</td>
  </tr>`).join('') : `<tr><td colspan="5" class="empty">No customers found</td></tr>`}
  </tbody></table></div>
  ${paginationBar(offset, total, PAGE_SIZE, 'customers')}`);
  document.getElementById('custFilterForm').onsubmit = e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    Object.keys(f).forEach(k => { if (!f[k]) delete f[k]; });
    customers(f, 0);
  };
  const clearBtn = document.getElementById('clearCustFilter');
  if (clearBtn) clearBtn.onclick = () => customers({}, 0);
  const prevBtn = document.getElementById('customersPrev'), nextBtn = document.getElementById('customersNext');
  if (prevBtn) prevBtn.onclick = () => customers(filters, Number(prevBtn.dataset.offset));
  if (nextBtn) nextBtn.onclick = () => customers(filters, Number(nextBtn.dataset.offset));
}

// ---------------- Admin: Settings ----------------
async function settingsPage() {
  loading(true);
  adminShell('settings', 'Settings', `
  <div class="card" style="max-width:480px;margin-bottom:16px">
    <h2>Peak Pricing</h2>
    <p style="color:var(--muted);font-size:13px">Set a temporary fare multiplier from 1× to 3×. The booking API applies it automatically.</p>
    <form id="pricingForm" style="display:flex;gap:10px;align-items:end;margin-top:12px"><div class="field" style="flex:1"><label>Multiplier</label><input id="peakMultiplier" name="peakMultiplier" type="number" min="1" max="3" step="0.1" value="1"></div><button class="btn">Save</button></form><p id="pricingMsg" class="error"></p>
  </div>
  <div class="card" style="max-width:480px">
    <h2>Change Password</h2>
    <form id="pwForm" style="display:flex;flex-direction:column;gap:14px;margin-top:12px">
      <div class="field"><label>Current Password</label><input type="password" name="currentPassword" required></div>
      <div class="field"><label>New Password</label><input type="password" name="newPassword" minlength="6" required></div>
      <button class="btn block">Update Password</button>
      <p id="pwMsg" class="error"></p>
    </form>
  </div>`);
  api('/api/pricing').then(r=>{document.getElementById('peakMultiplier').value=r.peakMultiplier||1;}).catch(()=>{});
  document.getElementById('pricingForm').onsubmit=async e=>{e.preventDefault();try{const r=await api('/api/admin/pricing',{method:'PATCH',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});document.getElementById('pricingMsg').style.color='var(--green)';document.getElementById('pricingMsg').textContent=`Saved at ${r.peakMultiplier}×`;toast('Peak pricing updated');}catch(x){document.getElementById('pricingMsg').textContent=x.message;}};
  document.getElementById('pwForm').onsubmit = async e => {
    e.preventDefault();
    const msgEl = document.getElementById('pwMsg');
    msgEl.textContent = '';
    try {
      await api('/api/admin/settings/password', { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
      msgEl.style.color = 'var(--green)';
      msgEl.textContent = 'Password updated successfully.';
      toast('Admin password updated successfully.');
      e.target.reset();
    } catch (x) {
      msgEl.style.color = 'var(--danger)';
      msgEl.textContent = x.message;
    }
  };
}

// ---------------- Customer: receipt / rating ----------------
function printReceipt(r) {
  const w=window.open('', '_blank', 'noopener,noreferrer,width=760,height=820');
  if(!w) return toast('Please allow pop-ups to print the receipt.','warning');
  w.document.write(`<!doctype html><html><head><title>Velan Travels Receipt ${esc(r.booking_id)}</title><style>body{font-family:Arial,sans-serif;padding:32px;max-width:700px;margin:auto;color:#18352a}h1{margin-bottom:4px}.box{border:1px solid #ddd;border-radius:12px;padding:18px;margin-top:18px}.row{display:flex;justify-content:space-between;gap:18px;padding:9px 0;border-bottom:1px solid #eee}.row:last-child{border:0}.amt{font-size:24px;font-weight:800}</style></head><body><h1>Velan Travels</h1><p>Booking Receipt</p><div class="box"><div class="row"><span>Booking ID</span><b>${esc(r.booking_id)}</b></div><div class="row"><span>Customer</span><b>${esc(r.customer_name)}</b></div><div class="row"><span>Mobile</span><b>${esc(r.mobile)}</b></div><div class="row"><span>Route</span><b>${esc(r.pickup_location)} → ${esc(r.drop_location)}</b></div><div class="row"><span>Date & Time</span><b>${esc(r.journey_date)} · ${esc(r.journey_time)}</b></div><div class="row"><span>Vehicle</span><b>${esc(r.vehicle_name||'-')} ${r.vehicle_number?'· '+esc(r.vehicle_number):''}</b></div><div class="row"><span>Status</span><b>${esc(r.status.replaceAll('_',' '))}</b></div><div class="row"><span>Fare</span><span class="amt">${r.estimated_fare?money(r.estimated_fare):'-'}</span></div></div><script>window.onload=()=>window.print();</script></body></html>`); w.document.close();
}
function showReviewForm(bookingId) {
  const rating=prompt('Rate your trip from 1 to 5'); if(rating===null)return;
  const n=Number(rating); if(!Number.isInteger(n)||n<1||n>5)return toast('Please enter a rating from 1 to 5.','error');
  const comment=prompt('Optional feedback (up to 500 characters):')||'';
  customerApi('/api/customer/bookings/'+encodeURIComponent(bookingId)+'/review',{method:'POST',body:JSON.stringify({rating:n,comment})}).then(()=>toast('Thank you for your feedback!')).catch(x=>toast(x.message,'error'));
}

// ---------------- Admin: Operations Center ----------------
async function operations() {
  loading(true);
  try {
    const [o, vs, reviews, audits, rev, notifications] = await Promise.all([api('/api/admin/operations'), api('/api/vehicles'), api('/api/admin/reviews'), api('/api/admin/audit'), api('/api/admin/revenue?days=30'), api('/api/admin/notifications')]);
    adminShell('operations','Operations Center',`
      <div class="stats-row"><div class="stat-card"><small>Fleet Available</small><b>${o.fleet.available||0}/${o.fleet.total||0}</b></div><div class="stat-card"><small>Driver Available</small><b>${o.drivers.available||0}/${o.drivers.total||0}</b></div><div class="stat-card pending"><small>Today's Unassigned</small><b>${o.unassigned||0}</b></div><div class="stat-card completed"><small>Average Rating</small><b>${Number(o.reviews.average||0).toFixed(1)} ★</b></div></div>
      <div class="dash-grid"><div class="card"><h2>Peak Pricing</h2><p style="color:var(--muted)">Optional multiplier for new bookings.</p><form id="peakForm" style="display:flex;gap:10px;flex-wrap:wrap;align-items:end"><label class="field" style="flex:1;min-width:140px"><span>Multiplier</span><input name="multiplier" type="number" min="1" max="3" step="0.05" value="${o.peakMultiplier}"></label><label style="display:flex;gap:8px;align-items:center;padding:11px 0"><input name="enabled" type="checkbox" ${o.peakEnabled?'checked':''}> Enable peak pricing</label><button class="btn">Save</button></form></div>
      <div class="card"><h2>Quick Tools</h2><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn secondary" id="backupBtn">Database Backup</button><button class="btn secondary" id="exportBtn">Export Bookings</button><a class="btn secondary" href="#analytics">Revenue Reports</a></div></div></div>
      <div class="dash-grid"><div class="card"><h2>Revenue — 30 Days</h2><div class="stats-row" style="margin:0"><div class="stat-card"><small>Bookings</small><b>${rev.totals.bookings||0}</b></div><div class="stat-card completed"><small>Completed Revenue</small><b>${money(rev.totals.revenue||0)}</b></div><div class="stat-card pending"><small>Outstanding</small><b>${money(rev.totals.outstanding||0)}</b></div></div><div style="max-height:180px;overflow:auto;margin-top:12px"><table><tbody>${rev.rows.slice(-10).map(r=>`<tr><td>${esc(r.date)}</td><td>${r.bookings}</td><td>${money(r.revenue||0)}</td><td>${money(r.paid_revenue||0)}</td></tr>`).join('')||'<tr><td>No revenue data</td></tr>'}</tbody></table></div></div><div class="card"><h2>Notifications</h2>${notifications.length?notifications.slice(0,8).map(n=>`<div style="padding:9px 0;border-bottom:1px solid var(--border)"><b>${esc(n.title)}</b><div style="font-size:12px;color:var(--muted)">${esc(n.message)}</div></div>`).join(''):'<p style="color:var(--muted)">All clear — no urgent notifications.</p>'}</div></div>
      <div class="dash-grid"><div class="card"><h2>Maintenance</h2><form id="maintForm" style="display:grid;gap:10px"><select name="vehicleId" required><option value="">Select vehicle</option>${vs.map(v=>`<option value="${v.id}">${esc(v.name)} · ${esc(v.vehicle_number)}</option>`).join('')}</select><input name="maintenanceType" placeholder="Maintenance type (service/repair)" required><input type="date" name="dueDate"><textarea name="notes" placeholder="Service notes"></textarea><button class="btn">Log Maintenance</button></form></div>
      <div class="card"><h2>Create Coupon</h2><form id="couponForm" style="display:grid;gap:10px"><input name="code" placeholder="Coupon code" required><select name="type"><option value="PERCENT">Percentage</option><option value="FLAT">Flat amount</option></select><input name="value" type="number" min="1" placeholder="Value" required><input name="minFare" type="number" min="0" placeholder="Minimum fare"><input name="maxDiscount" type="number" min="0" placeholder="Max discount (optional)"><input name="usageLimit" type="number" min="1" placeholder="Usage limit (optional)"><input name="expiresAt" type="date"><button class="btn">Create Coupon</button></form></div></div>
      <div class="card"><h2>Recent Reviews</h2><div class="table-wrap" style="box-shadow:none"><table><thead><tr><th>Booking</th><th>Customer</th><th>Rating</th><th>Feedback</th></tr></thead><tbody>${reviews.length?reviews.slice(0,12).map(r=>`<tr><td>${esc(r.booking_id)}</td><td>${esc(r.customer_name)}</td><td>${'★'.repeat(r.rating)}${'☆'.repeat(5-r.rating)}</td><td>${esc(r.comment||'-')}</td></tr>`).join(''):'<tr><td colspan="4" class="empty">No reviews yet</td></tr>'}</tbody></table></div></div>
      <div class="card"><h2>Audit Log</h2><div class="table-wrap" style="box-shadow:none"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Details</th></tr></thead><tbody>${audits.slice(0,15).map(a=>`<tr><td>${esc(a.created_at)}</td><td>${esc(a.actor_type)} · ${esc(a.actor||'-')}</td><td>${esc(a.action)}</td><td>${esc(a.details||'-')}</td></tr>`).join('')}</tbody></table></div></div>`);
    const bell=document.getElementById('adminBell'); if(bell){ bell.onclick=()=>toast(notifications.length?`${notifications.length} notification(s) need attention.`:'No new notifications.',notifications.length?'warning':''); }
    document.getElementById('peakForm').onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target));await api('/api/admin/settings/peak',{method:'PATCH',body:JSON.stringify({enabled:!!e.target.enabled.checked,multiplier:Number(f.multiplier)})});toast('Peak pricing settings saved.');operations();};
    document.getElementById('maintForm').onsubmit=async e=>{e.preventDefault();await api('/api/admin/maintenance',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});toast('Maintenance record added.');operations();};
    document.getElementById('couponForm').onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target)); await api('/api/admin/promos',{method:'POST',body:JSON.stringify({code:f.code,discountType:f.type,discountValue:f.value,minFare:f.minFare,maxDiscount:f.maxDiscount,expiresAt:f.expiresAt})});toast('Coupon created.');e.target.reset();};
    document.getElementById('backupBtn').onclick=async()=>{const r=await fetch('/api/admin/backup',{headers:{Authorization:'Bearer '+token}});if(!r.ok)return toast('Backup failed','error');const blob=await r.blob(),u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download='velan-travels-backup-'+todayStr()+'.db';a.click();URL.revokeObjectURL(u);toast('Database backup prepared.');};
    document.getElementById('exportBtn').onclick=()=>exportBookingsCsv();
  } catch(e) { toast(e.message,'error'); }
}

async function maintenancePage(){ loading(true); try{ const [rows,vehicles]=await Promise.all([api('/api/admin/maintenance'),api('/api/vehicles')]); adminShell('maintenance','Vehicle Maintenance',`<div class="card"><form id="mf" class="field-grid"><div class="field"><label>Vehicle</label><select name="vehicleId">${vehicles.map(v=>`<option value="${v.id}">${esc(v.name)} · ${esc(v.vehicle_number)}</option>`).join('')}</select></div><div class="field"><label>Maintenance Type</label><input name="maintenanceType" placeholder="Service / Tyres / Insurance" required></div><div class="field"><label>Due Date</label><input type="date" name="dueDate"></div><div class="field"><label>Notes</label><input name="notes"></div><button class="btn">Add Maintenance</button></form></div><div class="table-wrap"><table><thead><tr><th>Vehicle</th><th>Type</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.vehicle_name)} · ${esc(r.vehicle_number)}</td><td>${esc(r.maintenance_type)}</td><td>${esc(r.due_date||'-')}</td><td>${r.completed?'Completed':'Pending'}</td><td>${r.completed?'':'<button class="btn secondary" data-mid="'+r.id+'">Mark Done</button>'}</td></tr>`).join('')||'<tr><td colspan="5" class="empty">No maintenance records</td></tr>'}</tbody></table></div>`); document.getElementById('mf').onsubmit=async e=>{e.preventDefault();await api('/api/admin/maintenance',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});toast('Maintenance added');maintenancePage();};document.querySelectorAll('[data-mid]').forEach(b=>b.onclick=async()=>{await api('/api/admin/maintenance/'+b.dataset.mid,{method:'PATCH',body:JSON.stringify({completed:true})});maintenancePage();}); }catch(e){toast(e.message,'error');}}
async function promosPage(){ loading(true); try{const rows=await api('/api/admin/promos'); adminShell('promos','Promo Codes',`<div class="card"><form id="pf" class="field-grid"><div class="field"><label>Code</label><input name="code" placeholder="SAVE10" required></div><div class="field"><label>Type</label><select name="discountType"><option value="PERCENT">Percent</option><option value="FLAT">Flat</option></select></div><div class="field"><label>Discount</label><input type="number" name="discountValue" min="0" required></div><div class="field"><label>Max Discount</label><input type="number" name="maxDiscount" min="0"></div><div class="field"><label>Minimum Fare</label><input type="number" name="minFare" min="0"></div><div class="field"><label>Expires</label><input type="date" name="expiresAt"></div><button class="btn">Create Promo</button></form></div><div class="table-wrap"><table><thead><tr><th>Code</th><th>Discount</th><th>Expires</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.code)}</td><td>${r.discount_type==='FLAT'?money(r.discount_value):r.discount_value+'%'}</td><td>${esc(r.expires_at||'-')}</td><td>${r.active?'Active':'Disabled'}</td><td><button class="btn secondary" data-pid="${r.id}" data-active="${r.active?'0':'1'}">${r.active?'Disable':'Enable'}</button></td></tr>`).join('')||'<tr><td colspan="5" class="empty">No promo codes</td></tr>'}</tbody></table></div>`);document.getElementById('pf').onsubmit=async e=>{e.preventDefault();await api('/api/admin/promos',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});toast('Promo created');promosPage();};document.querySelectorAll('[data-pid]').forEach(b=>b.onclick=async()=>{await api('/api/admin/promos/'+b.dataset.pid,{method:'PATCH',body:JSON.stringify({active:b.dataset.active==='1'})});promosPage();});}catch(e){toast(e.message,'error');}}
async function auditPage(){loading(true);try{const rows=await api('/api/admin/audit');adminShell('audit','Audit Log',`<div class="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.created_at)}</td><td>${esc(r.actor_type)} · ${esc(r.actor)}</td><td>${esc(r.action)}</td><td>${esc(r.entity_type)} #${esc(r.entity_id)}</td><td>${esc(r.details||'-')}</td></tr>`).join('')||'<tr><td colspan="5" class="empty">No audit events</td></tr>'}</tbody></table></div>`);}catch(e){toast(e.message,'error');}}

// ---------------- Admin: Booking Calendar ----------------
async function calendarPage() {
  loading(true);
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
  const to = new Date(now.getFullYear(), now.getMonth()+1, 0).toISOString().slice(0,10);
  try {
    const rows = await api(`/api/admin/calendar?from=${from}&to=${to}`);
    const byDate = {};
    rows.forEach(r => (byDate[r.journey_date] ||= []).push(r));
    const days = [];
    for (let d=new Date(from+'T00:00:00'); d<=new Date(to+'T00:00:00'); d.setDate(d.getDate()+1)) {
      const key=d.toISOString().slice(0,10), list=byDate[key]||[];
      days.push(`<div class="card" style="min-height:120px"><b>${key}</b><div style="margin-top:8px;display:grid;gap:6px">${list.length?list.map(r=>`<div style="padding:7px;border:1px solid var(--border);border-radius:8px"><b>${esc(r.journey_time)}</b> · ${esc(r.booking_id)} <span class="status-pill status-${r.status}" style="float:right">${r.status.replaceAll('_',' ')}</span><div style="font-size:12px;color:var(--muted);margin-top:3px">${esc(r.customer_name)} · ${esc(r.vehicle_name||'Unassigned')}</div></div>`).join(''):'<span style="color:var(--muted);font-size:12px">No bookings</span>'}</div></div>`);
    }
    adminShell('calendar','Booking Calendar',`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><p style="color:var(--muted);margin:0">Current month booking schedule</p><button class="btn secondary" id="calExport">Export CSV</button></div><div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));padding:0">${days.join('')}</div>`);
    document.getElementById('calExport').onclick=()=>exportBookingsCsv({date:''});
  } catch(e) { toast(e.message,'error'); }
}

// ---------------- Router ----------------
function router() {
  const h = location.hash.replace('#', '') || 'home';
  if (h === 'book') return booking();
  if (h === 'status') return status();
  if (h === 'driver') return driverPortal();
  if (h === 'admin') return login();
  if (h === 'customer-login') return customerLogin();
  if (h === 'my-bookings') return myBookings();
  if (h === 'dashboard') return dashboard();
  if (h === 'analytics') return analytics();
  if (h === 'calendar') return calendarPage();
  if (h === 'operations') return operations();
  if (h === 'customers') return customers();
  if (h === 'settings') return settingsPage();
  if (h === 'maintenance') return maintenancePage();
  if (h === 'promos') return promosPage();
  if (h === 'audit') return auditPage();
  if (h === 'bookings') return bookings();
  if (h === 'vehicles') return vehicles();
  if (h === 'drivers') return drivers();
  if (h === 'logout') {
    api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    token = ''; localStorage.removeItem('vt_token'); location.hash = ''; return;
  }
  home();
}
window.addEventListener('hashchange', router);
router();
