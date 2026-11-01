# open-design <-> uxxxer handoff (maker -> checker)

open-design is the MAKER (design.zp.digital): it generates components, stories, and QA patterns.
uxxxer is the CHECKER (uxx.zp.digital): it approves, pins, and enforces them across the estate.

## The split (binding)
- open-design GENERATES a component (story + play function + a11y) and SUBMITS it to uxxxer.
- open-design NEVER writes uxxxer's `registry/` directly — `registry/` is owned by the approval
  workflow (submit -> review -> promote -> pin), not by the maker.
- "golden" in open-design is NOT approval. Only a uxxxer `pinned` status (server-signed) is approval.
- Consumers assemble from the uxxxer registry via `USE_APPROVED:<id>`, enforced by the no-invention gate.

## Submit a generated component
```bash
curl -X POST https://uxx.zp.digital/v1/capture \
  -H 'Authorization: Bearer <author-key>' -H 'content-type: application/json' \
  -d '{"id":"watch-widget","name":"WatchWidget","story":"registry/stories/watch-widget.stories.tsx",
       "playFunction":"...","a11yTest":"...","agentInstructions":"...","doNot":["..."]}'
# -> review -> promote -> pin (uxxxer hashes the story bytes + Ed25519-signs the pin)
```

## The 3 Laws (3LOF, shared with consumers)
1. Assemble from the approved registry — never hand-roll an approved primitive.
2. Submit new primitives through approval — never write `registry/` directly.
3. Pin to the approved baseline — `snapshotHash` must match the story sha256.

See docs/uxxxer-skill.md (the DSH skill) + docs/onboarding.md (the consumer gate lane) in the uxxxer repo.
