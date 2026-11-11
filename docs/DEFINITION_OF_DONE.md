# Definition of Done — Backend

A change is **done** when every box below is checked. Not "code written" — *done*.

`npm run verify` automates everything marked 🤖. The rest requires judgement and must be
checked by the person or agent doing the work.

> **Do not report a task complete without running `npm run verify`.**
> If you could not run it, say so explicitly and say why.

**Skills that operate against this document:**
[`review-backend-code`](../.agents/skills/review-backend-code/SKILL.md) walks the checklist
as an audit · [`write-backend-test`](../.agents/skills/write-backend-test/SKILL.md) covers §4
· [`secure-node-endpoint`](../.agents/skills/secure-node-endpoint/SKILL.md) covers the auth
debt below · [`scaffold-node-api`](../.agents/skills/scaffold-node-api/SKILL.md) builds new
endpoints to this bar.

---

## 1. Gate — automated

Run `npm run verify` (or `npm run verify:quick` while iterating). It must exit **0**.

| ✅ | Check | Rule |
| :-- | :-- | :-- |
| 🤖 | `npx tsc --noEmit` — zero errors in `src/` | R7 |
| 🤖 | Tests typecheck (they are excluded from the build — see AGENTS.md §10) | R7 |
| 🤖 | No real credentials in source | R4 |
| 🤖 | `.env` not tracked by git | R4 |
| 🤖 | `schema.prisma` change is accompanied by a migration | §11 |
| 🤖 | Tenant-isolation count has not increased | R1 |
| 🤖 | `any` count has not increased | R2 |
| 🤖 | Zod-validation gap count has not increased | R3 |
| 🤖 | Direct `process.env` count has not increased | R4 |
| 🤖 | Controller-Prisma count has not increased | R5 |
| 🤖 | Unguarded external-call count has not increased | R6 |
| 🤖 | `npx jest` — all suites green (needs live Postgres) | §10 |

**A gate failure is never fixed by raising a baseline.** See AGENTS.md §9.

---

## 2. Correctness — manual

- [ ] The change does what was asked, and **only** what was asked. Scope creep is reverted
      or called out explicitly.
- [ ] Every new query filters by `tenantId` **in the same statement** — not fetch-then-check.
- [ ] Every new external input is Zod-parsed with `safeParse` before any logic reads it.
- [ ] Invalid input returns **400** with a useful message, never a 500 and never a stack trace.
- [ ] Any new booking write handles Prisma **`P2002`** as a user-facing conflict.
- [ ] Every new external call has `try/catch` and a defined fallback.
- [ ] Every background promise has a `.catch()`. An unhandled rejection kills the process.
- [ ] No failed integration can roll back a confirmed booking.
- [ ] **R9:** no fabricated data. A failure or missing setting is reported as such (error or empty result), never
      replaced by made-up values, and nothing reports success for work that was not done.
- [ ] No response interpolates untrusted input into HTML, and none carries a stack
      trace, an internal exception message, or a secret.

## 3. Voice-path latency — manual

Only if the change touches `/voice/*` or anything it calls:

- [ ] Nothing new runs inside the request/response cycle — notifications, calendar sync,
      logging and analytics are fire-and-forget.
- [ ] Queries `select` only the fields used; no relation tree pulled to read one field.
- [ ] The response still comfortably fits the **sub-50 ms** availability budget.
- [ ] No new reliance on the in-process slot cache for **correctness** (§5).

## 4. Tests — manual

- [ ] New endpoint → happy path **plus** a validation-failure 400 **plus** a
      tenant-isolation case proving tenant B cannot read tenant A's row.
- [ ] New concurrency/`P2002` path → a test that actually races two writes.
- [ ] External HTTP is mocked; the database is **not** mocked.
- [ ] Full suite run, not just the file you touched.

## 5. Data model — manual

- [ ] You stated which model generation you targeted: legacy `Appointment` (live traffic)
      or universal `Booking` (migrated but unused). See AGENTS.md §8.
- [ ] Schema change → `npm run prisma:generate` **and** a migration committed.
- [ ] New table → `tenantId`, `@@index([tenantId])`, `onDelete: Cascade`.

## 6. Config & docs — manual

- [ ] New env var → added to `src/config/index.ts` Zod schema **and** `.env.example`.
- [ ] No new direct `process.env` read outside `src/config/`.
- [ ] `AGENTS.md` updated if you changed an architectural rule or added a known trap.

## 7. Reporting — manual

- [ ] You ran `npm run verify` and are reporting its **actual** result.
- [ ] Anything you could not verify is stated plainly, with the reason.
- [ ] Test failures are reported with their output, not summarised away.
- [ ] Debt you paid down is reflected by a **lowered** baseline.

---

## Known debt

Recorded in `scripts/baseline.json` as of 2026-08-25. The gate tolerates these counts and
fails on any increase. Listed worst-first — fix on contact.

### 🔴 P1 — `offboardResource` is cross-tenant writable

`src/controllers/tenant.controller.ts` deactivates a resource by id with **no `tenantId`
filter**:

```ts
await prisma.resource.update({ where: { id }, data: { isActive: false } });
```

Combined with the absent auth layer, any caller who knows or guesses a resource UUID can
offboard **another tenant's** doctor. This is a live tenant-isolation break, not
theoretical. Fix: `updateMany({ where: { id, tenantId } })`, and reject when count is 0.

### 🔴 P1 — no authentication anywhere

No middleware verifies identity — `src/middlewares/` contains only `error.middleware.ts`.
`tenantId` comes from an unverified `x-tenant-id` header or query param
(`appointment.controller.ts:13`), so every `/appointments/*` and `/tenant/*` endpoint is open
to anyone who can reach the port. `User.passwordHash` exists; nothing issues or checks a
session, and `JWT_SECRET` is set in the deployment environment but referenced nowhere in
`src/`. Until fixed, no endpoint may be described as secured.

Note that the UUID check on line 14 raises a message beginning `'Unauthorized: ...'`. It is a
**format** check, not an authorization check. Do not read it as coverage.

### 🔴 P1 — `/voice/check-availability` has no API-key check

`voice.controller.ts` verifies `WEBHOOK_API_KEY` in `handleWebhook`, but `checkAvailability`
does not — and it is registered on **both** GET and POST (`voice.routes.ts:10-11`). It is a
public, uncapped proxy into Cal.com keyed by a caller-supplied `tenant_id`: a tenant
enumeration vector and, given the sub-50 ms design target, the cheapest endpoint in the
service to abuse.

Two lower-severity notes on the webhook check it sits next to: the comparison
`clientKey !== config.WEBHOOK_API_KEY` is not constant-time, and it accepts the raw
`authorization` header when the value is not `Bearer`-prefixed.

### 🟠 P2 — reflected XSS in the OAuth callback

`auth.controller.ts:97` interpolates `req.query.error` directly into an HTML response, and
line 242 does the same with `error.message`. Both are attacker-controllable via a crafted
redirect to `/api/v1/auth/google/callback?error=…`. These are the service's only
HTML-rendering paths and neither escapes; line 242 additionally leaks internal exception
text to the browser.

### 🟠 P2 — CORS is fully open

`app.ts:12` is a bare `app.use(cors())`, sending `Access-Control-Allow-Origin: *` on every
route. Combined with `x-tenant-id` being the only "credential", any web page can read tenant
data from a visitor's network position. `FRONTEND_URL` is already provisioned in the
deployment environment for exactly this and is unused.

### 🟠 P2 — tenant-isolation gaps (baseline 3)

| Location | Issue |
| :-- | :-- |
| `tenant.controller.ts` | The P1 above |
| `scripts/sync-calendar.ts` | `findFirst({ where: { googleEventId } })` — no tenant filter |
| `voice.service.ts` | `callLog.update({ where: { id } })` — fetch-then-update; tenant-checked upstream, so lower severity, but not the required shape |

### 🟠 P2 — controllers bypass the service layer (baseline 3)

`auth`, `tenant` and `appointment` controllers all call Prisma directly, violating R5. The
`tenant` controller additionally holds business logic (cache invalidation, soft-delete
policy) that belongs in a service.

### 🟠 P2 — `tenant.controller.ts` has no Zod validation (baseline 1)

It reads `req.body` and `req.query` raw. Every other controller validates. Needs schemas in
`src/schemas/`.

### 🟡 P3 — silent config failures (baseline 12)

Twelve direct `process.env` reads across `sms`, `email`, `payment`, `telehealth`, `calcom`
and `db` services. A typo in any of those keys fails at runtime, not at boot, defeating the
point of the Zod config loader.

### 🟡 P3 — `any` usage (baseline 22)

Worst offenders: `voice.service.ts` (8) and `appointment.controller.ts` (6). The webhook
payload path is the hardest and highest-value place to fix — that is exactly where
untrusted vendor input enters.

### 🟡 P3 — infrastructure gaps

- Slot cache is a per-process `Map`; Redis/BullMQ from the roadmap is absent, so cache
  invalidation does not propagate across instances.
- Universal models (`Booking`, `Customer`, `ServiceType`) are unused — all traffic still
  lands on legacy `Appointment`. They were *not* migrated until 2026-08-27: they had been
  created with `prisma db push`, so `migrate deploy` on a fresh database produced 6 of 12
  tables and omitted `resources`. Closed by `20260827000000_baseline_universal_models`;
  a rebuild from migrations alone is verified to match `schema.prisma`. **Never use
  `prisma db push` on this project** — it is what caused the gap.
- Test suite takes over 2 minutes with no watch-mode split.
