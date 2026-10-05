# FEC Equipment Look-Ahead - Test Build

Separate prototype based on the deployment pattern of `fec-service-call`.

## Demo URLs
- `/request.html?token=demo-northstar-2026-10-1` - trade partner form
- `/dashboard.html` - private management dashboard
- `/vendor.html` - United Rentals read-only planning view

Default local/demo passwords (change on Render):
- Management: `demo-admin`
- Vendor: `demo-vendor`

## Render deployment
1. Create a NEW GitHub repository, for example `fec-equipment-lookahead`. Do not replace the existing service-call repository.
2. Upload all files from this project to the new repository.
3. In Render choose **New > Web Service** and connect the new repository.
4. Runtime: Node. Build command: `npm install`. Start command: `npm start`.
5. Add environment variables:
   - `ADMIN_PASSWORD` = a strong management password
   - `VENDOR_PASSWORD` = a separate strong United Rentals password
   - `PUBLIC_BASE_URL` = the Render URL after the first deploy, e.g. `https://fec-equipment-lookahead.onrender.com`
   - `TEST_MODE` = `true`
   - `TEST_EMAIL` = `aciraky@fecrent.com`
   - `POWER_AUTOMATE_URL` = leave blank for the first UI test; later paste the Power Automate HTTP trigger URL
6. Deploy.
7. Open the root Render URL and test the three views.

## Important prototype limitation
This test build stores submissions in `data/store.json`. Render's normal filesystem is ephemeral, so data can reset on redeploy/restart. This is acceptable for the first UI/workflow test only. Before production, move submissions, trade-partner contacts, cycles, and reminder history to Render Postgres (or another approved persistent database).

## Email automation design
The existing Service Call app already uses Power Automate through `POWER_AUTOMATE_URL`. Keep that pattern here.

Recommended production flows:
1. **Cycle launch**: Recurrence trigger for first and third Wednesday -> get active trade partners -> send each a unique request URL -> copy configured GC visibility recipients.
2. **Reminder**: Daily recurrence -> identify outstanding requests whose last reminder was at least two days ago -> send reminder -> increment reminder history. Stop automatically when status is complete.
3. **Submission notification**: App submission -> optionally call Power Automate -> send receipt/visibility notice and update downstream reporting.

During TEST MODE, all outbound messages should be redirected to `TEST_EMAIL` rather than real trade-partner addresses.

## Security before production
- Replace the prototype password scheme with Microsoft Entra ID / approved authentication for management and vendor users.
- Generate long random per-cycle trade-partner tokens and rotate them each cycle.
- Use a persistent database.
- Add audit logs for sends, reminders, opens if available, form access, and submissions.
- Confirm project/company approval before loading real contact lists or granting external vendor access.
