# AGENTS.md — Backend Engineering Rules

Canonical instruction file for **any** LLM coding agent (Claude Code, Cursor, Copilot,
Codex, Windsurf, Aider, Gemini CLI, …) working in this repository.

`CLAUDE.md`, `.cursor/rules/`, and `.github/copilot-instructions.md` all point here.
**This file is the single source of truth.** If a tool-specific file disagrees, this wins.

---

## 0. What this service is

`voice-agent-backend` is the orchestration API for a **multi-tenant, multi-industry AI
booking platform**. Its primary consumer is a **live voice AI phone agent** (Vapi/Retell)
that calls webhooks mid-conversation while a human waits on the line.

Two consequences drive nearly every rule below:

1. **Latency is a correctness property.** A slow response is a broken response — the caller
   hears dead air.
2. **Every byte of input is hostile.** Webhook bodies arrive from third-party vendors over
   the public internet, and their payload shapes change without notice.

Stack: Node 20 · TypeScript (strict) · Express 4 · Prisma 6 · PostgreSQL · Jest.

---

## 1. Non-negotiable rules

Hard gates. Code violating them must not be proposed as complete. Each maps to an
automated check in `scripts/verify.sh`.

| # | Rule | Enforced by |
| :-- | :-- | :-- |
| R1 | Every DB query touching tenant data filters by `tenantId` **in the same statement**. | `guards/tenant-isolation.sh` |
| R2 | No `any`. No `@ts-ignore`/`@ts-expect-error` without an adjacent justification comment. | `guards/no-any.sh` |
| R3 | Every external input is Zod-parsed **before** business logic reads it. | `guards/validation.sh` |
| R4 | No secrets in code. All config flows through `src/config/index.ts`. | `guards/secrets.sh` |
| R5 | Controllers hold no business logic and no direct Prisma access. | `guards/layering.sh` |
| R6 | Every external network call has `try/catch` and a defined fallback. | `guards/external-calls.sh` |
| R7 | `npx tsc --noEmit` passes with zero errors. | `verify.sh` |
| R8 | No new work inside the request/response cycle of a voice call. | review |
| R9 | **No fabricated data.** An API answer, seed, fallback or log never invents values or reports success that did not happen. | review only (cannot be automated) |

**R9 in plain words (owner rule, 2026-11-04):**
- When a call fails or data is missing, say so (an error or an empty result). Never return made-up slots, ids, names,
  prices, summaries or counts to look helpful.
- Never report success for work that was not done (a booking, a message, a payment, a calendar event).
- Seed and demo scripts must not write invented customers, phones or appointments into a real tenant.
- If something is not configured (for example Google Calendar), the answer says it is not connected.

R1–R6 carry a **baseline ratchet** (§9): pre-existing violations are recorded and
tolerated, but the count must never increase.

---

## 2. Layering — where code goes

Strict one-directional flow. **Never skip a layer, never call upward.**

```
routes/        HTTP surface only: path, method, middleware chain. Zero logic.
   ↓
controllers/   Parse + Zod-validate input, call ONE service, map result to HTTP status.
   ↓           No Prisma. No business rules. No multi-service orchestration.
services/      All business logic, orchestration, external integrations, transactions.
   ↓
db.service.ts  The only Prisma client instance. Import it; never construct another.
```

| Path | Contains | Rule |
| :-- | :-- | :-- |
| `src/schemas/` | Zod schemas | One per request shape. Export the inferred type too. |
| `src/config/` | Env parsing, static presets | Fail fast at boot. Never read `process.env` elsewhere. |
| `src/middlewares/` | Cross-cutting concerns | Must call `next(err)`; never respond directly on error. |
| `src/scripts/` | One-off operational scripts | Never imported by runtime code. |

**Adding an endpoint** — required order:
1. Zod schema in `src/schemas/`
2. Service method (business logic, unit-testable without HTTP)
3. Controller method (validate → call service → respond)
4. Route file, then wire into `src/routes/index.ts`
5. Test in `tests/`

If you are writing `prisma.` inside a controller, you skipped step 2.

---

## 3. Multi-tenancy — highest-severity area

A tenant-isolation bug leaks one customer's patient data to another. Treat as Sev-1.

**Required:**
```ts
await prisma.appointment.findFirst({ where: { id, tenantId } });
await prisma.appointment.updateMany({ where: { id, tenantId }, data: { … } });
```

**Forbidden:**
```ts
// ❌ id alone — any tenant can pass any UUID
await prisma.appointment.findUnique({ where: { id } });

// ❌ fetch-then-check: still reads another tenant's row into memory
const appt = await prisma.appointment.findUnique({ where: { id } });
if (appt.tenantId !== tenantId) throw new Error('nope');
```

Prefer `updateMany`/`deleteMany` with a compound `where` over `update`/`delete` by id,
precisely so `tenantId` can be part of the filter.

**Schema rule:** every business table has `tenantId String @db.Uuid`, an
`@@index([tenantId])`, and `onDelete: Cascade` to `Tenant`.

### ⚠️ Known weakness — do not build on it

There is **no authentication middleware in this repo.** `tenantId` arrives from an
unverified `x-tenant-id` header or `tenant_id` query param. `User.passwordHash` exists in
the schema but nothing issues or verifies a session.

R1 therefore buys *isolation between well-behaved callers*, not security against a
malicious one. When auth is added, `tenantId` must come from a verified token claim and the
header path must be removed. Until then: **never describe an endpoint as "secured", and do
not add endpoints exposing more data than existing ones.**

---

## 4. Zero-trust input validation

`/voice/webhook` already accepts **three payload shapes** (Vapi
`message.type === 'tool-calls'`, Retell root-level `{name, tool_call_id}`, and a flat
custom-tool format). Assume a fourth appears without warning.

- Use `safeParse`, never `parse`, at HTTP boundaries. Return 400 with the formatted error;
  never let a Zod throw become a 500.
- Validate the **narrow thing you need**, not the whole vendor envelope. Vendors add fields
  freely; a strict envelope schema rejects valid traffic.
- Validate `tenant_id` as `z.string().uuid()` every time.
- Re-check coerced dates: `new Date(x)` then `isNaN(d.getTime())`. A voice model will
  cheerfully send `"next Tuesday"`.
- Never interpolate user input into a query string. Prisma parameterises; keep it that way.

---

## 5. Latency budget

Conversational budget is **1.5 s** total; this service owns a **sub-50 ms** slice for
availability lookups.

**Must be off the request path:** calendar sync, SMS/WhatsApp, email, `.ics` generation,
transcript analysis, call-log writes, AI summarisation.

House pattern (`appointment.service.ts`) — respond first, then:
```ts
this.bgSync(...).catch((e) => console.error('[Ctx] bg sync failed:', e));
```
A background promise **must** have `.catch()`. An unhandled rejection kills the process.

**Query rules:** `select` only fields you use; never `include` a relation tree to read one
field; every `tenantId` filter must hit the existing index; paginate with `take`.

### ⚠️ The slot cache is not a shared cache

`slot-cache.service.ts` is an **in-process `Map`** with a 30 s TTL — per-worker, lost on
restart. Therefore:
- It serves *speed*, never *correctness*. A cache hit is never proof a slot is free.
- `slotCacheService.invalidate()` clears only the calling process. With >1 instance, other
  workers serve stale slots for up to 30 s.
- Redis/BullMQ is on the roadmap but **not present**. Do not add features assuming cache
  coherence across processes.

---

## 6. Double-booking — the database is the referee

The guarantee lives in a Postgres constraint, not application code:

```prisma
@@unique([tenantId, resourceId, bookingDateTime])     // Booking (universal)
@@unique([tenantId, calendarId, appointmentDateTime]) // Appointment (legacy, live)
```

Required shape — attempt the write, handle Prisma code **`P2002`** as a user-facing
"that slot just went" conflict:

```ts
try {
  return await prisma.appointment.create({ data });
} catch (e: unknown) {
  if (isPrismaError(e, 'P2002')) throw new SlotTakenError(…);
  throw e;
}
```

A pre-flight availability check is a **UX affordance** producing a nicer spoken response.
It is never the safety mechanism. Never replace the constraint with an application-level
check, and never assume the gap between check and write is atomic. It is not.

---

## 7. External integrations

Every service in `src/services/` follows one house pattern; new ones must too:

1. **Detect placeholder credentials** and return realistic mock data, logging that it did.
   This keeps `npm run dev` and the test suite working with no live keys.
2. **`try/catch` every call**, with a defined fallback — degrade, don't crash.
3. **Never let a failed integration roll back a confirmed booking.** The booking is the
   source of truth; a failed calendar sync is a retry, not a cancellation.

Current: Google Calendar (live, per-tenant OAuth), Cal.com v2 (live), Twilio (mock + live
path), SendGrid + `.ics` (mock + live path), Daily.co (live), Zoom/Meet (stubs),
Stripe (mock).

### ⚠️ Config debt

`src/config/index.ts` validates only the Google, database, port and webhook-key vars.
**Six services read `process.env` directly** (`sms`, `email`, `payment`, `telehealth`,
`calcom`, `db`), so a typo in those keys fails silently at runtime instead of at boot.

When you touch one of those services, **move its keys into the config schema** as optional
entries and read from `config`. Do not add new direct `process.env` reads.

---

## 8. Data model — know which generation you are touching

The schema holds **two generations side by side**:

| Model set | Status | Reality |
| :-- | :-- | :-- |
| `Appointment` | **Legacy — carries all live traffic** | Every booking the voice agent makes lands here. |
| `Booking`, `Customer`, `ServiceType`, `Resource`, `Department` | **Universal — migrated but unused** | Defined, indexed, constrained. **No service writes to them.** |

Before writing booking logic, state which set you target:
- Bug fix or small feature on the live path → `Appointment`.
- Migration toward the universal model → `Booking`, and say so explicitly.

Never quietly write to both. Never assume `Booking` holds data — it does not.

---

## 9. The baseline ratchet

Gates R1–R6 have real pre-existing violations. Hard-failing would leave the gate
permanently red, and a red gate gets ignored. So each guard compares against
`scripts/baseline.json`:

```
count > baseline  → FAIL  (you added a violation — fix your change)
count < baseline  → PASS  + prompt to lower the baseline (debt paid, thank you)
count = baseline  → PASS
```

**You may lower a baseline. You may never raise one.** Raising a baseline to turn
`verify.sh` green is the most damaging thing an agent can do here — it silently converts a
caught bug into permanent debt. If a gate fails, fix the code.

Current debt is itemised in `docs/DEFINITION_OF_DONE.md § Known debt`.

---

## 10. Testing

- Jest + ts-jest + supertest. Tests in `tests/*.test.ts`.
- **Integration tests need a live PostgreSQL** on `DATABASE_URL`. There is no test
  container; `pg_isready` must succeed or failures are confusing.
- The suite is **slow (>2 min)**. Use `npx jest <pattern>` while iterating; run the full
  suite before declaring done.
- `tsconfig.json` **excludes** `**/*.test.ts` from typecheck, so a type error in a test is
  invisible to `tsc --noEmit`. `verify.sh` typechecks tests separately — do not rely on the
  build to catch them.
- Every new endpoint needs: happy path, a validation-failure 400, and a tenant-isolation
  case proving tenant B cannot read tenant A's row.
- Every new `P2002`/concurrency path needs a test that actually races two writes.
- Mock external HTTP (`global.fetch`); never mock the database.

---

## 11. Commands

```bash
npm run dev              # tsx watch — DO NOT run this yourself (see §12)
npm run build            # tsc → dist/
npm test                 # jest, needs live Postgres
npx tsc --noEmit         # typecheck only
npm run prisma:migrate   # prisma migrate dev
npm run prisma:generate  # regenerate client after schema edits
npm run prisma:seed      # seed tenant + demo data

npm run verify           # ← the DoD gate. Run before claiming done.
npm run verify:quick     # gates minus the slow test suite
```

After **any** `schema.prisma` edit: `npm run prisma:generate` **and** create a migration.
A schema change without a migration is an incomplete change.

---

## 12. Operational constraints

- **Do not start servers.** The user runs `npm run dev` in their own terminal. Do not
  launch, restart, or background the API, the frontend, or Postgres unless explicitly asked.
- **Do not touch the frontend from this repo.** `voice-agent-backend` and
  `voice-agent-frontend` are separate git repositories with separate remotes. No shared
  imports, no cross-repo edits in one change.
- **Do not commit or push unless asked.** When asked: confirm `.env` is ignored, review
  `git status` before staging, never force-push.
- `.env` is gitignored and stays so. `.env.example` holds placeholders only — when you add
  a config key, add its placeholder there in the same change.

---

## 13. Definition of Done

A task is done only when `docs/DEFINITION_OF_DONE.md` is satisfied and `npm run verify`
exits 0. **Do not report a task complete without having run it.** If you could not run it,
say so explicitly and say why.
