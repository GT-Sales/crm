# Quality and testing plan

A plan for measuring the CRM against recognised standards, written on
21 Nov 2026 after the audit issues #81 to #114. Nothing here is built yet. It
starts once those issues are fixed and merged.

The CRM is a multi-site system that holds customer identity documents and
contact details for Canadian customers, with a staff admin, website intake,
customer tracking and an AI assistant. The plan is chosen for that: security
and privacy first, then performance, then an independent check.

## Owner answers (21 Nov 2026)

- **No staging environment exists.** Creating one (backend, database and
  storage, synthetic data only) is the first step of phase 3 and is needed for
  the dynamic scan in phase 2. Nothing in this plan runs load or attack
  traffic against production.
- **Traffic is very low today and no peak is forecast.** Load tests therefore
  measure where the system starts to slow or fail, to know the headroom,
  instead of testing against a target. The spike and soak tests are low
  priority until traffic grows.
- **No site takes card payments.** PCI DSS does not apply.

## Phase 1: automated checks in CI

Cheap, run on every pull request, and catch regressions for good.

| Test                  | Tool                                           | What it covers                               |
| --------------------- | ---------------------------------------------- | -------------------------------------------- |
| Static security scan  | CodeQL                                         | Injection and unsafe patterns in the code    |
| Secret scan           | gitleaks                                       | Keys or passwords committed by mistake       |
| Dependency scan       | Dependabot (already on) and `pnpm audit` in CI | Known vulnerable packages                    |
| Accessibility         | axe inside the existing Playwright suites      | WCAG 2.2 AA on every main admin page         |
| Front-end performance | Lighthouse CI with score budgets               | The admin's main pages, signed in            |
| Maintainability       | SonarQube Cloud                                | Duplication, complexity and coverage, graded |

## Phase 2: security review

1. **OWASP ASVS Level 2.** A chapter-by-chapter check of authentication,
   sessions, access control, file upload and data protection. Level 2 is the
   level for an application that holds passports.
2. **OWASP API Security Top 10.** The website service credentials, draft
   grants and customer tracking routes, since those face the internet.
3. **Tenant isolation tests.** Automated tests that try to read or change
   another site's data on every route.
4. **OWASP Top 10 for LLM applications.** For Ask AI: prompt injection through
   lead data and attachments, data leakage, and actions taken without
   confirmation.
5. **Dynamic scan.** OWASP ZAP against a staging deployment.

## Phase 3: performance and load

| Test            | Tool                            | What it answers                                                            |
| --------------- | ------------------------------- | -------------------------------------------------------------------------- |
| Page speed      | Lighthouse CI (from phase 1)    | Are the Leads, lead, Tasks and Dashboard pages fast to load and respond?   |
| Real-user speed | Vercel Speed Insights           | Core Web Vitals from actual staff sessions                                 |
| API load test   | k6                              | How many lead submissions and staff requests per second before errors?     |
| Spike test      | k6                              | Does a burst of website orders get through without a lost lead?            |
| Soak test       | k6, a few hours                 | Do the outbox and scheduler keep up over time, with no memory growth?      |
| Database        | `pg_stat_statements`, `EXPLAIN` | Which queries are slow under row-level security at ten times today's data? |
| Bundle size     | Next.js bundle analyzer         | Is the admin shipping more JavaScript than it needs?                       |

Load tests use a staging environment with synthetic data only.

## Phase 4: privacy and recovery

1. **PIPEDA review.** Map what personal data is held, why, for how long and
   who can see it, and check the retention and erasure jobs against that.
2. **Erasure verification.** Erase a synthetic customer and prove nothing
   remains in the database, storage, Ask AI chats or logs, and that the backup
   retention policy covers the rest.
3. **Restore drill.** Restore last night's backup into a clean environment and
   time it (RUNBOOKS/restore.md). Repeat quarterly.
4. **Failure tests.** Storage down, mail provider down, database connection
   lost: confirm nothing is lost and the alerts fire.

## Phase 5: independent check

An external penetration test, once phases 1 to 4 are clean. An outside tester
finds what an internal review misses.

## Not planned for now

- **SOC 2 and ISO 27001.** Formal audits, worth their cost only when a business
  customer or partner asks for the certificate.
- **PCI DSS.** No site takes card payments. Revisit if that changes.
- **Mutation testing.** Useful later; low priority given the existing tests.

## Order

Phase 1, then 2, 3, 4 and 5. Phases 2 and 3 can overlap.

## Engineering habits that raise the baseline

The audit's real bugs had a few shapes in common. Closing them as classes,
not one at a time, matters as much as any test above:

- Back every important rule with a database constraint.
- Do the permission check and the write in the same transaction, and add a
  concurrency test for every write path.
- Record any storage deletion, email or alert before doing it and retry until
  it is confirmed, as the outbox does for mail.
- Split the largest files (the leads inbox, the lead record, the Ask AI
  conversation store).
- Generate documentation where it can be generated, and let CI compare the
  rest with the code (environment variables, script names).
