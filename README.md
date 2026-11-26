# Payment Control

Every payment, in or out of an order, is recorded, matched to the order and checked against the bank statement, so the owner always knows what has been received and what is still outstanding.

Built for the HelloPM Buildathon. Problem and journey come from a real business (wedding photography, 50+ orders a month, payments in several splits by cash, UPI and bank transfer, tracked by hand in a spreadsheet and a back-office panel).

## What works today (MVP 1)

| Area | What it does |
|---|---|
| Three roles | **Uploader** adds payments and sees only their own entries. **Manager** sees balances, confirms cash, checks statements. **Owner** also manages people, settings and the API connector. |
| Orders | Order ID, client, total. Any number of payment splits. Outstanding is always calculated. |
| Add payment | Upload a screenshot, the app reads amount, date, time, transaction ID and payer (Google text detection), the person checks the values and saves. Cash is entered by hand. |
| Controls | Same transaction ID twice is refused. Same amount and time with no ID is flagged. Cash stays "to confirm" until a **different** person confirms it. A person cannot verify their own entry. Managers cannot change an order total once payments exist. Closing an order needs everything verified (owner can override with a written reason). |
| Bank statement check | Upload one month's CSV. Each online payment is matched to a credit and marked verified, or flagged if no credit is found. Credits with no payment record are listed. |
| Business API connector | Each payment event is sent to your own system as a secure HTTPS call. |
| Audit log | Every change, with who and when. |

## Not built yet

- Google Sheets connector (planned next)
- Summary emails to managers
- PDF and Excel statements (CSV only)
- Expense analysis (MVP 2) and GST, tax and reporting (MVP 3)
- Screenshot reading has been tested with typed copies of four real screenshots, not yet with live Google output

## Demo login

Without a database connected the app starts in demo mode with sample orders and three accounts. **Demo data is temporary.**

| Username | Role |
|---|---|
| `owner` | Owner |
| `manager` | Manager |
| `uploader` | Uploader |

Password for all three: `demo1234`. Set `NO_DEMO=1` to switch the demo accounts off and create your own owner on first visit.

## Run it for real

1. **Database (free):** create a project at supabase.com. In the SQL editor, run `schema.sql`.
2. **Vercel environment variables:**

| Name | Value |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_KEY` | The service role key (server only, never shown in the browser) |
| `SESSION_SECRET` | A long random string |
| `GOOGLE_VISION_KEY` | Optional. Google Cloud API key restricted to the Vision API. Without it, people type the details from the screenshot. |
| `NO_DEMO` | Optional. `1` turns the demo accounts off |

3. Redeploy. Google text detection is free for the first 1,000 units a month per Google's pricing page, then $1.50 per 1,000, and needs a billing account (set a budget alert).

Vercel's Hobby plan is for personal, non-commercial use. Move to Pro before real businesses depend on it.

## Business API: what your tech team adds

One protected endpoint on your panel. We send:

```
POST https://your-panel.example.com/api/record-payment
Authorization: Bearer <secret key you give us>
X-Idempotency-Key: <payment id>:<event>
Content-Type: application/json

{ "event": "created" | "cash_confirmed" | "verified" | "rejected" | "flagged" | "released",
  "payment_id": "pay_...", "order_id": "ORD-1042", "amount": 30000,
  "mode": "upi" | "transfer" | "cash", "date": "2026-11-25T11:18",
  "reference": "bank transaction id or empty", "status": "client_reported" }
```

Your endpoint should check the key, ignore a repeat of the same `X-Idempotency-Key`, allow only this one action, and answer with status 200 and a receipt ID.

## Tests

```
node test/parse.test.js   # screenshot text reader, on the four real samples
node test/api.test.js     # roles, controls, cash, statement, connector (49 checks)
node test/ui.test.js      # browser flows for all three roles (needs Playwright)
node test/serve.js        # local dev server on :8790
```

## Stack

Static pages in `public/`, one serverless function in `api/index.js` (no dependencies), Supabase for storage, Google text detection for screenshots.


## Order approval and the spreadsheet

- The sales team (uploader role) creates orders. A manager or owner must approve each one on the Review screen before any payment can be added to it. Rejected orders need a written reason.
- When an order is approved (or created by a manager), a row is appended to the **Orders** tab of your Google Sheet. Every payment event is appended to the **Payments** tab. The connector only appends; it never edits or deletes rows.
- Setup: create a Google Cloud service account, share the sheet with its email as Editor, add tabs named `Orders` and `Payments`, then set in Vercel: `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_KEY` (the private key, with line breaks written as `\n`) and `SHEETS_ID`. Without these the connector stays off.
- Tested against a mock Google only. It has not been run against a real sheet yet.

## How it works now

- Sales creates an order (ID, client, total, first advance screenshot). A manager or owner approves, changes and approves, or sends it back. Approval locks the total and creates the invoice.
- Later payments need no approval. Drop or paste the screenshot; the app reads it. A screenshot without a transaction ID is refused. Cash, entries above the owner's limit and entries made by managers go to the owner.
- Bank statements are matched by transaction ID. Unmatched items stay "validation pending" and are never marked wrong. Cash shows as manually validated, not system validated.
- Owner: Settings (business, GST or tax number, customer fields, storage, limits), Reports with download, Clear old files (after download).
- Storage choices that include a Google Sheet or your own system only append copies. The app always keeps every record.
- Run `node test/api.test.js` and `node test/ui.test.js`.

## Evaluation before going live

- `node eval/run-reader.js` scores what the app extracts from payment screenshots (amount, transaction ID, date, phone, payment plan) against expected answers, and fails if a wrong amount would be shown without a confirm prompt. Cases are in `eval/reader-cases.json`. Add a case for every real screenshot that misreads: paste the text from "What the reader saw".
- `node eval/scenarios.js` runs ten business scenarios on demo data (full payment and auto-close, plans, mismatch approval, duplicate ID, missing ID, cash approval, wrong statement amount, role walls, total change approval).
