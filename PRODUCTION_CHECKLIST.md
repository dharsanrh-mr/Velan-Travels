# Velan Travels — Final Production Checklist

1. Set `NODE_ENV=production`.
2. Set a strong `ADMIN_PASSWORD` and change it after first login.
3. Set `CORS_ORIGINS` to the exact public frontend origin(s).
4. Set `TRUST_PROXY=1` only when running behind one trusted reverse proxy.
5. Configure Razorpay keys for live payments.
6. Configure Twilio SMS/WhatsApp sender credentials.
7. Configure Google Maps browser/server keys with separate restrictions.
8. Run `npm install` inside `backend/`, then `npm start`.
9. Confirm `/api/health` returns `ok:true` and `/api/ready` returns `ready:true`.
10. Take a database backup before major updates.
11. Test: booking → driver assignment → payment → tracking → completion → receipt → rating.
12. Serve the site over HTTPS in production.
