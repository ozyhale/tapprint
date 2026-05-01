# TapPrint

TapPrint turns a dedicated Gmail inbox into a simple print queue: PDF attachments appear on an operator phone UI (copies, black/color print, delete). The app runs on a **Windows print-server PC** (your old laptop) with **Node.js**, **Express**, **SQLite**, and **SumatraPDF** driving Windows printer queues.

## Two machines

- **Print server:** Old laptop connected to the printer. Install Node, SumatraPDF, copy this project, configure `.env`, run `npm start` (or register a startup task).
- **Dev PC (optional):** You can edit code anywhere; deploy the folder to the laptop when ready.

## Prerequisites (print server)

1. **Node.js 18+** from [nodejs.org](https://nodejs.org/).
2. **SumatraPDF** installed. Note the path to `SumatraPDF.exe` (defaults often under `C:\Program Files\SumatraPDF\`).
3. **Two Windows printer queues** (recommended): duplicate your printer in Windows so you have one queue forced grayscale/black and one full color. Example names: `ReceiptPrinter_BW` and `ReceiptPrinter_Color`. Put those exact names in `.env`.
4. **Google Cloud project + Gmail API** for the dedicated mailbox:
  - Enable **Gmail API**.
  - OAuth consent + Desktop app **Client ID / Secret**.
  - Create a **refresh token** for an account with scope `**https://www.googleapis.com/auth/gmail.modify`** (read messages and mark read). A local helper script is included in this repo (recommended).

## Setup

```bash
cd C:\TapPrint   # or your folder
copy .env.example .env
# edit .env — PIN, SESSION_SECRET, Gmail vars, SUMATRA_PATH, printer names
npm install
npm run check-print
npm run oauth-google
npm start
```

Open on the operator phone (same Wi‑Fi): `http://<laptop-LAN-IP>:8080` (change port if you set `PORT`).

### Verify printers and SumatraPDF

`npm run check-print` lists whether `SUMATRA_PATH` exists and whether `PRINTER_BW` / `PRINTER_COLOR` exist in Windows.

Manual CLI smoke test (replace paths):

```text
"C:\Program Files\SumatraPDF\SumatraPDF.exe" -print-to "ReceiptPrinter_BW" -silent "C:\path\to\test.pdf"
```

### Get Gmail refresh token (recommended)

Use the built-in helper so your refresh token is guaranteed to match `.env` credentials:

```bash
npm run oauth-google
```

What it does:

- Uses `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from your `.env`.
- Opens browser consent for scope `https://www.googleapis.com/auth/gmail.modify`.
- Prints `GOOGLE_REFRESH_TOKEN=...` in terminal for you to paste into `.env`.

If you use an OAuth client of type **Web application**, add this exact redirect URI in Google Cloud:

`http://127.0.0.1:34579/oauth2callback`

If you use a **Desktop app** OAuth client, this local loopback redirect works out of the box.

## Configuration (.env)


| Variable                                                           | Meaning                                         |
| ------------------------------------------------------------------ | ----------------------------------------------- |
| `PORT`, `HOST`                                                     | Listen address (`HOST=0.0.0.0` for LAN phones). |
| `SESSION_SECRET`                                                   | Long random string for cookies.                 |
| `OPERATOR_PIN`                                                     | PIN shown to operators after unlock.            |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | Gmail OAuth refresh flow.                       |
| `POLL_INTERVAL_SECONDS`                                            | How often to check Gmail (default 45).          |
| `MAX_PDF_MB`                                                       | Skip larger attachments.                        |
| `JOBS_DIR`, `DATABASE_PATH`                                        | PDF storage and SQLite file.                    |
| `SUMATRA_PATH`                                                     | Full path to SumatraPDF.exe.                    |
| `PRINTER_BW`, `PRINTER_COLOR`                                      | Windows queue names.                            |


## Gmail OAuth troubleshooting

- `**unauthorized_client`** usually means your refresh token was minted for a different OAuth client. Regenerate it with `npm run oauth-google` and replace `GOOGLE_REFRESH_TOKEN`.
- `**redirect_uri_mismatch`** means the OAuth client does not allow the callback URL. For Web app clients, add `http://127.0.0.1:34579/oauth2callback`.
- `**access_denied**` in Testing mode usually means the mailbox account is not listed under OAuth consent screen **Test users**.

## Run at startup (Windows)

### Option A: NSSM (Non-Sucking Service Manager)

1. Install [NSSM](https://nssm.cc/).
2. Point application to your `node.exe`, arguments `C:\TapPrint\src\server.js`, startup directory `C:\TapPrint`.
3. Set environment or rely on `.env` in that folder.

### Option B: Task Scheduler

Run PowerShell **as Administrator**:

```powershell
$action = New-ScheduledTaskAction -Execute "node" -Argument "src\server.js" -WorkingDirectory "C:\TapPrint"
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName "TapPrint" -Action $action -Trigger $trigger -Principal $principal
```

Adjust paths. Ensure Node is on PATH for the account running the task.

## Security notes

- Use a **strong PIN** and **random SESSION_SECRET**.
- Prefer **Tailscale** or shop LAN only; avoid exposing port 8080 to the public internet without TLS and tighter auth.
- **better-sqlite3** requires native build tools on Windows if prebuilt binaries are missing (`npm install` may prompt for Visual Studio Build Tools).

## API (after PIN login session)

- `POST /login` `{ "pin": "..." }`
- `POST /logout`
- `GET /api/me`
- `GET /api/jobs`
- `PATCH /api/jobs/:id` `{ "copies": 2 }`
- `POST /api/jobs/:id/print` `{ "mode": "bw"|"color", "copies": 2, "client_request_id": "uuid" }`
- `DELETE /api/jobs/:id`

Successful print removes the job row and deletes the PDF file from disk.

## License

Use and modify for your shop as needed.