# AI automation authoring verification

## Implemented behavior

The existing assistant can read automation lists, definitions, catalogs and recorded
run summaries, and prepare visual create/edit proposals. The model has no save,
activate, enable or test-email tool. An actor-owned signed proposal reference is
required by the explicit Save draft endpoint. Edits use expected revisions and
preserve unchanged step IDs; previous definitions are visible in the card. Inline
edits must be reviewed before saving and supersede the old confirmation token.

Saving reuses the ordinary flow store inside a single transaction with its receipt.
Concurrent retries return one flow and revision, including when the save response
is lost. New flows start Off with no active version. Actor/workspace scope is derived
from the session, access is checked again at confirmation, and a separate per-site
allowlist defaults authoring off. Proposal rows have forced actor RLS and backup
read policy; old records are included in bounded operational retention. Actor-owned
cleanup and a serialized 100-row cap also bound storage while retention is disabled.

Simulation uses a read-only database transaction and the live condition SQL builder
against synthetic values. It cannot enqueue an email or mutate a lead/task. It
checks current site references, reports selected and uncovered branches, and labels
waits/actions simulated. This does not certify live documents, scheduler or delivery.

## Evidence

- Full suite: 228 files / 2,735 passed, four backup-tool tests skipped locally.
- Authenticated browser suite: 37 passed, including phone/desktop proposal editing,
  simulation, explicit saves, lost-response retries, existing-draft edits and builder
  links. New fixture flows are archived through the ordinary UI after each journey.
- Shell journeys: 14 passed; tooling tests: 47 passed.
- Focused authoring suite: 24 passed, covering token alteration/expiry, actor and
  tenant ownership, revision conflicts, manual draft protection, transactional rollback,
  concurrent saves, permission changes, limits, SDK schema serialization and simulation.
- Synthetic/live predicate comparisons cover typed properties, defaults, stage,
  assignee and plan conditions against a disposable database.
- Migrations 0021/0022 applied to a separate empty disposable database; checked forced
  RLS and runtime/backup grants, then removed that database.
- Workspace lint, typechecks, formatting, generated OpenAPI and production builds
  are required before commit and checked again by CI.

The four skipped tests require local pg_dump/age; CI installs them. Browser model and
email adapters are deterministic test doubles; no live customer email was sent.

## Release gates

No hosted migration or allowlist change was performed. Apply migrations and deploy
before enabling an internal test site. The 30-request fixture set and proposal-only
runner are ready; real-model interpretation quality must be reviewed before wider
release. Follow [the release runbook](../RUNBOOKS/ai-automation-authoring.md) for the
controlled event/wait/delivery check. Chat-based publishing/enabling remain deferred;
users publish and switch flows on explicitly in the ordinary builder.
