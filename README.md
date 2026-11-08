# Mobile Shop Backend

Independent Express/Mongoose API for the mobile shop inventory system. This folder contains no frontend runtime dependencies.

## Local setup

1. Copy `.env.example` to `.env` and set `MONGODB_URI`, `JWT_SECRET`, `SETUP_KEY`, and `HICELLTEK_API_KEY` as needed.
2. Install dependencies: `npm install`.
3. Start development mode: `npm run dev`.
4. Check `http://localhost:<PORT>/api/health` (`PORT` is 5001 in the supplied local `.env`; Render supplies its own port).

The API binds to `process.env.PORT` and defaults to port 5000. The Atlas database defaults to `mobile_shop`. Never commit `.env` or place backend secrets in frontend build variables.

## Render deployment

Create a Node.js Web Service from this folder/repository, with:

- Root Directory: repository root
- Build Command: `npm install`
- Start Command: `npm start`

Configure Render environment variables: `NODE_ENV=production`, `MAIN_MONGODB_URI`, `MAIN_MONGODB_DB=mobile_shop`, `TAC_MONGODB_URI`, `TAC_MONGODB_DB=mobile_shop_tac`, a random `JWT_SECRET`, a random `SETUP_KEY`, `CLIENT_ORIGIN` (initially `http://localhost:5173` until a frontend origin is configured), and `HICELLTEK_API_KEY` if external identification is enabled. Render supplies `PORT`.

Set Atlas Network Access to allow the Render service's outbound IPs where available. Do not reset the database. Transactions require an Atlas replica set.

## API overview

- `GET /api/health` (reports both database connections)
- `GET/POST /api/purchase-invoices`, `GET /api/purchase-invoices/available-for-stock`, `GET/PUT/DELETE /api/purchase-invoices/:id`, `GET /api/purchase-invoices/:id/stock`, `GET /api/purchase-invoices/:id/attachment`
- `DELETE /api/inventory/:id` (in-stock items only; restores invoice quantity)
- `GET /api/auth/status`, `POST /api/auth/setup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `GET/POST/PATCH /api/inventory`, `GET /api/inventory/check-imei`, `GET /api/inventory/search-imei-last-six?digits=123456`, `GET /api/inventory/:id`
- `GET /api/financial/status`, `POST /api/financial/pin` (set), `PUT /api/financial/pin` (change), `POST /api/financial/verify`, `POST /api/financial/lock`, `POST /api/financial/pin/reset`
- `POST /api/device-lookup`, `GET /api/device-lookup/tac/:tac`
- Admin: `POST /api/device-lookup/import`, `GET /api/device-lookup/import/status`, `GET /api/device-lookup/import/history`, `GET /api/device-lookup/import/history/:id`
- `GET/POST /api/sales`, `GET /api/sales/:id`
- `GET/POST/PATCH/DELETE /api/dealers`
- `GET /api/dashboard`, `GET /api/reports`, `GET /api/reports/export.csv`

All endpoints except health and auth bootstrap/login/logout require the HttpOnly JWT cookie. Admin setup is only available when no user exists.

## Two MongoDB Atlas clusters

| Cluster | Env | Database | Collections |
| --- | --- | --- | --- |
| 1 MAIN | `MAIN_MONGODB_URI` (or `MONGODB_URI`) | `MAIN_MONGODB_DB` (`mobile_shop`) | users, dealers, inventories, sales, expenses, purchaseinvoices, devicemodels, auditlogs, usersecurity |
| 2 TAC | `TAC_MONGODB_URI` | `TAC_MONGODB_DB` (`mobile_shop_tac`) | TACRecords, TACImportLogs, invoiceFiles.files / invoiceFiles.chunks (GridFS) |

- MAIN is Mongoose's default connection; the TAC models are registered only on the separate `tacConnection` (`models/tac.js`). Each has its own pool (`MONGODB_MAX_POOL`).
- The API needs MAIN to start. TAC connects independently and retries in the background. While TAC is down, inventory, sales, invoices and reports keep working; device lookup goes straight to HiCellTek (or manual entry); invoice attachments and TAC admin endpoints return 503. `GET /api/health` shows both states.
- SIGTERM/SIGINT close the HTTP server and both connections.
- Moving existing TAC data: `npm run tac:migrate` copies `TACRecords` + `TACImportLogs` from MAIN to TAC, upserting by `_id` (safe to re-run) and verifying counts and contents. Add `-- --drop-source` to drop them from MAIN afterwards (only if verification passed).
- Atlas setup: create a second cluster (M0 is fine) in Atlas, add a database user, allow your Render outbound IPs (or 0.0.0.0/0) under Network Access, and put its SRV string in `TAC_MONGODB_URI`. Set both URIs on Render.

## Purchase invoices (stock inward)

Create the dealer invoice first, then add phones one by one against it.

- **Model** `PurchaseInvoice` (MAIN): `dealer`, `dealerName`, `invoiceNumber`, `invoiceNumberKey` (upper case, no spaces), `invoiceDate`, `totalPurchaseAmount`, `totalQuantity`, `addedQuantity`, `remainingQuantity`, `brand`, `notes`, `invoiceFile` (`storageProvider: 'gridfs'`, `fileId`, `originalName`, `mimeType`, `size`, `sha256`, `uploadedAt`), `createdBy`. Unique index `{ dealer, invoiceNumberKey }`, so the same number may exist for different dealers. `status` is computed (Pending / Partially Added / Completed) and never stored.
- **Inventory** gains `purchaseInvoiceId`. When it is set, `dealer`, `dealerName`, `invoiceNumber` and `purchaseDate` are copied from the invoice, kept in sync when the invoice changes, and cannot be edited on the phone (409 `MANAGED_BY_INVOICE`). Stock without an invoice works as before.
- **Quantity tracking:** `POST /api/inventory` with `purchaseInvoiceId` runs in a transaction: a conditional `$inc` takes one unit (only if `remainingQuantity > 0`), then the phone is created. A duplicate IMEI or any failure rolls the count back. Concurrent entries can never exceed the quantity (tested with 12 parallel requests on a 5-phone invoice). Moving a phone between invoices (`PATCH { purchaseInvoiceId }`) and `DELETE /api/inventory/:id` adjust both sides in the same transaction. Selling does not change invoice counts. `totalQuantity` cannot go below `addedQuantity`.
- **Attachments:** PDF/JPG/PNG up to `INVOICE_MAX_FILE_MB` (8 MB), checked by file content (magic bytes), not by name. Stored in GridFS on the TAC cluster (255 KB chunks, never Base64). Served only through `GET /api/purchase-invoices/:id/attachment[?download=1]` with `Cache-Control: private, no-store`. Replacing a file deletes the old one, and deleting an (empty) invoice deletes its file.
- **Financial PIN:** quantities are always visible. When locked, `totalPurchaseAmount`, `linkedPurchaseTotal` and linked phone prices are `null`; creating an invoice, changing its amount or attachment, and opening the attachment return 403 `FINANCIAL_PIN_REQUIRED`.
- **Profit:** reports and the dashboard keep using per-phone `purchasePrice` only. Invoice totals are kept separately (invoice detail shows the invoice total next to the sum of linked phone prices), so nothing is counted twice.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/purchase-invoices` | multipart (`invoiceFile` optional) or JSON: `dealer`, `invoiceNumber`, `invoiceDate`, `totalPurchaseAmount`, `totalQuantity`, `brand?`, `notes?`. PIN. 409 `DUPLICATE_INVOICE` |
| GET | `/api/purchase-invoices` | `search`, `dealer`, `from`, `to`, `status` (pending/partial/completed), `page`, `limit` |
| GET | `/api/purchase-invoices/available-for-stock` | invoices with remaining > 0 (`search`, `dealer`); no amounts |
| GET | `/api/purchase-invoices/:id` | invoice + dealer + linked in-stock/sold counts + `linkedPurchaseTotal` |
| GET | `/api/purchase-invoices/:id/stock` | linked phones (paginated; price redacted when locked) |
| GET | `/api/purchase-invoices/:id/attachment` | stream (PIN); `?download=1` for attachment |
| PUT | `/api/purchase-invoices/:id` | any create field, optional new `invoiceFile`, `removeAttachment=true`. Dealer only while no phones are linked; 409 `QUANTITY_BELOW_ADDED` |
| DELETE | `/api/purchase-invoices/:id` | only when no phones are linked (409 `INVOICE_HAS_STOCK`) |
| POST | `/api/inventory` | now accepts `purchaseInvoiceId` (then `purchaseDate`/dealer come from the invoice). 409 `INVOICE_QUANTITY_EXCEEDED` |
| PATCH | `/api/inventory/:id` | `purchaseInvoiceId` to move, `null` to unlink |
| DELETE | `/api/inventory/:id` | in-stock only; restores invoice quantity |

## Quick stock-out (IMEI last 6 digits)

`GET /api/inventory/search-imei-last-six?digits=123456` returns every **in-stock** phone whose IMEI 1 or IMEI 2 ends with the 6 digits (max 25, `truncated: true` if more). The response has brand, device, model number, IMEIs, `matchedImei`, invoice number, dealer and status, and no cost data. With no match it returns `total: 0` and the message "No available phone found with these IMEI last 6 digits." The app never auto-selects: the user picks a result, and the sale goes through the existing `POST /api/sales` with that phone's `matchedImei`. That is the same transactional sale used for barcode scans: the `IN_STOCK -> SOLD` switch is atomic, so a phone can be sold only once and concurrent attempts get 409. `imeiLastSix` is kept in sync on save, indexed with `status`, and backfilled at startup for older records.

## Financial security PIN

Purchase costs and profit are protected by a 4-digit PIN, enforced by the API (not just hidden in the UI).

- **Opt-in:** protection starts when the owner sets a PIN (`POST /api/financial/pin` with the account password). Before that, every API behaves as before.
- **Storage:** `usersecurity` collection, one document per user: `financialPinHash` = bcrypt(cost 12) of HMAC-SHA256(`FINANCIAL_PIN_PEPPER`, PIN), plus `pinEnabled`, `pinUpdatedAt`, `failedAttempts`, `lockedUntil` and `financialSession` (`jti`, `binding`, `expiresAt`). The PIN is never stored, logged or returned, and the hash is `select: false`.
- **Unlock:** `POST /api/financial/verify { pin }` sets the HttpOnly cookie `shop_financial` (5 minutes, `FINANCIAL_UNLOCK_MINUTES`). The token is signed, bound to the user and to the login token, and must match the server-side `jti`. `POST /api/financial/lock`, logout, PIN change and PIN reset revoke it immediately. The token is never in a response body.
- **Lockout:** 5 wrong PINs (`FINANCIAL_PIN_MAX_ATTEMPTS`) lock the account for 15 minutes (`FINANCIAL_PIN_LOCKOUT_MINUTES`), even for the correct PIN, plus a per-IP limit (`FINANCIAL_PIN_RATE_LIMIT` per 15 min). Wrong PINs get the generic "Incorrect PIN."; locked accounts get 429 "Too many incorrect attempts. Try again later." Events are written to `auditlogs` (`FINANCIAL_PIN_FAILED`, `FINANCIAL_PIN_LOCKOUT`, `FINANCIAL_UNLOCKED`, ...) without the PIN.
- **Change:** `PUT /api/financial/pin { currentPin, newPin, confirmPin }`. The current PIN counts toward lockout.
- **Forgotten PIN:** `POST /api/financial/pin/reset { password, recoveryKey, newPin, confirmPin }`. The recovery key is `FINANCIAL_PIN_RECOVERY_KEY` (falls back to `SETUP_KEY`). Server-side alternative: `npm run pin:reset`, which prompts for the username and new PIN.

When locked (after a PIN exists):

| API | Behaviour |
| --- | --- |
| `GET /api/inventory`, `/inventory/:id` | `purchasePrice: null`, `financialLocked: true`; price sorting ignored |
| `POST /api/inventory`, `PATCH` with `purchasePrice` | 403 `FINANCIAL_PIN_REQUIRED` (other edits allowed) |
| `GET /api/sales`, `/sales/:id`, `POST /api/sales` response | `purchasePrice`, `grossProfit`, `netProfit`, `snapshot.purchasePrice` are `null`. Selling itself is allowed, and profit is always computed and stored by the server. |
| `GET /api/dashboard` | investment, purchase total, profit, daily profit, recent-sale profit are `null`; counts and revenue remain |
| `GET /api/dealers` | `totalPurchaseAmount: null` |
| `GET /api/reports`, `/reports/export.csv` | 403 `FINANCIAL_PIN_REQUIRED` |

There is no separate purchase-invoice module: inventory only stores an `invoiceNumber`, which is not treated as financial.

Tests: `npm run test:financial` starts API servers against a temporary `mobile_shop_test_<timestamp>` database, creates a throwaway admin, runs the stock-out and PIN scenarios, and drops that database. Your real database is not touched.

## Device identification (hybrid TAC lookup)

`POST /api/device-lookup` with `{ "imei": "..." }`:

1. Validate the 15-digit IMEI (Luhn) and take the first 8 digits as the TAC.
2. Look up `TACRecords` in MongoDB. A record with brand, device name **and** model number is returned with `source: "local_database"` and no external call.
3. Otherwise call HiCellTek (`POST https://imei.hicelltek.com/api/v1/tac/lookup`, `X-Api-Key`, body `{ "query": "<TAC>" }`). Mapping: brand = `brand.name`, device = `marketing_name` (fallback `model`), model number = `model_info` (maker prefix removed). Empty HiCellTek fields are filled from the local record only when both name the same brand. `source: "hicelltek_api"`.
4. If neither source identifies the device: `success: false`, `source: "manual_entry"`, message "Device details could not be identified automatically. Please enter the details manually."

Status codes: 200 identified (check `complete` / `missingFields`), 400 invalid IMEI, 404 not found anywhere, 429 HiCellTek quota reached, 502 HiCellTek error (e.g. bad key), 503 HiCellTek/MongoDB unavailable, 504 HiCellTek timeout (`HICELLTEK_TIMEOUT_MS`, default 10000). Concurrent lookups for the same TAC share one HiCellTek request. HiCellTek responses are **not** stored: its published terms grant no storage/reuse right.

Note: about 211k local records have no model number in the source data, so those lookups still use HiCellTek quota (the response also reports `quota.remaining`). When the quota runs out, the partial local record (brand + device) is still returned.

## TAC database (`TACRecords`)

Fields: `tac` (8-digit string, unique), `brandName`, `deviceName`, `modelNumber`, `source`, `sourceVersion`, `sourceUpdatedAt`, `sourceRecordDate` (Osmocom submission date — not an allocation date), `releaseYear` (from MoazEb text — not an allocation date), `allocationDate` (always `null`: no public source publishes GSMA allocation dates), `sources[]` (every source that lists the TAC), `importedAt`, `lastImportId`, timestamps. Indexes: `tac` unique, `brandName+deviceName`, `source`. Import runs are logged in `TACImportLogs`.

The older `tacrecords` collection from the previous importer is left untouched and is no longer read. Drop it in Atlas yourself once you are satisfied.

### Sources

| Source | Used | License | Notes |
| --- | --- | --- | --- |
| [MoazEb tac-database](https://github.com/MoazEb/tac-database) `tac_full.csv` | Yes (priority 2) | MIT | ~276k TACs, updated Oct 2026; includes the Optus V36 list. Upstream says it also aggregates Osmocom (CC-BY-SA-3.0) data, so keep attribution to both. |
| [Osmocom tacdb](https://tacdb.osmocom.org/) SQLite/CSV export | Yes (priority 1) | CC-BY-SA-3.0 | ~22.5k TACs, last submission Jan 2023; no model-number field. |
| [FCCID.io TAC data](https://fccid.io/TAC/data) | No | No reuse license found | Blocked by a bot "Security check" (HTTP 403); not bypassed. |
| [Optus changelog](https://www.isthisphoneblocked.net.au/optus/changelog) | Not directly | No redistribution license published | Unreachable from the build machine; its V36 list is already in MoazEb. |

Dates: no source publishes TAC allocation dates, so records cannot be reliably filtered to "allocated since January 2025". The collection is a **full dataset snapshot**, not a list of 2025+ allocations.

### Import / update

```bash
npm run import:tac:dry             # download + parse + report, no writes
npm run import:tac                 # import all sources
node scripts/importTacDatabase.js --source=moazeb --report=./tac-report.json
node scripts/importTacDatabase.js --moazeb-file=./tac_full.csv --osmocom-file=./tacdb.sqlite3   # offline files
```

Rules: upsert by TAC with `bulkWrite`; records missing from a newer snapshot are never deleted; a value is never replaced by an empty one; a lower-priority source can only fill empty fields (and only for the same brand); duplicates and conflicts are counted and sampled in the report; only one import can run at a time. Admins can also start an import with `POST /api/device-lookup/import` (optional body `{ "sources": ["moazeb"] }`, returns 202 + `importId`). On small hosts prefer the CLI, because a full import holds about 300k records in memory.

## Checks

- `npm run lint`
- `npm run test:smoke` (requires the API running and reachable Atlas; preserves an existing admin and cleans its temporary business records. Setup/password login is skipped when an admin already exists.)
- `npm run test:invoices` (both clusters + invoices; temporary databases on both clusters, dropped afterwards; `-- --live-hicelltek` adds one real HiCellTek lookup)
- `npm run test:smoke` with `SMOKE_FINANCIAL_PIN=<pin>` also runs the PIN-protected checks against your real data
- `npm run test:financial` (quick stock-out + financial PIN, isolated temporary database)
- `npm run test:tac` (hybrid lookup + import tests; HiCellTek is mocked, temporary `*_test` collections are dropped afterwards)
- `npm run import:tac` (writes/upserts TAC records)
- `GET /api/health` (reports both database connections)
- `GET/POST /api/purchase-invoices`, `GET /api/purchase-invoices/available-for-stock`, `GET/PUT/DELETE /api/purchase-invoices/:id`, `GET /api/purchase-invoices/:id/stock`, `GET /api/purchase-invoices/:id/attachment`
- `DELETE /api/inventory/:id` (in-stock items only; restores invoice quantity)

See [BACKEND_TEST_REPORT.md](BACKEND_TEST_REPORT.md) for the latest results and remaining deployment/provider verification.

The HiCellTek API requires an API key from HiCellTek and may enforce request quotas. Test provider lookups deliberately; do not make test calls that consume quota without approval.
