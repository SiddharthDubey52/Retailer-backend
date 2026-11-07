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
- `POST /api/device-lookup`, `GET /api/device-lookup/tac/:tac`, `GET /api/device-lookup/import/status`, `POST /api/device-lookup/import`
- `GET/POST /api/sales`, `GET /api/sales/:id`
- `GET/POST/PATCH/DELETE /api/dealers`
- `GET /api/dashboard`, `GET /api/reports`, `GET /api/reports/export.csv`

All endpoints except health and auth bootstrap/login/logout require the HttpOnly JWT cookie. Admin setup is only available when no user exists.

## TAC import

Run `npm run import:tac` to import the public Osmocom JSON export into the `TacRecord` collection. The import is idempotent and preserves non-Osmocom records. Osmocom data is CC-BY-SA 3.0; retain source attribution when redistributing it.

## Checks

- `npm run lint`
- `npm run test:smoke` (requires the API running and reachable Atlas; preserves an existing admin and cleans its temporary business records. Setup/password login is skipped when an admin already exists.)
- `npm run import:tac` (writes/upserts TAC records)
- `GET /api/health`

See [BACKEND_TEST_REPORT.md](BACKEND_TEST_REPORT.md) for the latest results and remaining deployment/provider verification.

The HiCellTek API requires an API key from HiCellTek and may enforce request quotas. Test provider lookups deliberately; do not make test calls that consume quota without approval.
