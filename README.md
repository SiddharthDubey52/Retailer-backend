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

Configure Render environment variables: `NODE_ENV=production`, `MONGODB_URI`, `MONGODB_DB=mobile_shop`, a random `JWT_SECRET`, a random `SETUP_KEY`, `CLIENT_ORIGIN` (initially `http://localhost:5173` until a frontend origin is configured), and `HICELLTEK_API_KEY` if external identification is enabled. Render supplies `PORT`.

Set Atlas Network Access to allow the Render service's outbound IPs where available. Do not reset the database. Transactions require an Atlas replica set.

## API overview

- `GET /api/health`
- `GET /api/auth/status`, `POST /api/auth/setup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `GET/POST/PATCH /api/inventory`, `GET /api/inventory/check-imei`, `GET /api/inventory/:id`
- `POST /api/device-lookup`, `GET /api/device-lookup/tac/:tac`
- Admin: `POST /api/device-lookup/import`, `GET /api/device-lookup/import/status`, `GET /api/device-lookup/import/history`, `GET /api/device-lookup/import/history/:id`
- `GET/POST /api/sales`, `GET /api/sales/:id`
- `GET/POST/PATCH/DELETE /api/dealers`
- `GET /api/dashboard`, `GET /api/reports`, `GET /api/reports/export.csv`

All endpoints except health and auth bootstrap/login/logout require the HttpOnly JWT cookie. Admin setup is only available when no user exists.

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
- `npm run test:tac` (hybrid lookup + import tests; HiCellTek is mocked, temporary `*_test` collections are dropped afterwards)
- `npm run import:tac` (writes/upserts TAC records)
- `GET /api/health`

See [BACKEND_TEST_REPORT.md](BACKEND_TEST_REPORT.md) for the latest results and remaining deployment/provider verification.

The HiCellTek API requires an API key from HiCellTek and may enforce request quotas. Test provider lookups deliberately; do not make test calls that consume quota without approval.
