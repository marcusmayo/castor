# /triage — Message Triage

Process items in `inbox/`: classify each, propose action-register entries and
pipeline updates, and archive what has been handled. Propose, don't mutate —
every state write happens only after explicit operator confirmation.

## Inputs
- `inbox/` admitted files and, for each, its `<name>.flags.json` sidecar
  (written by the intake lane): `extraction.scan_state`, `tripwire.flagged`,
  `has_vision_pending`, `attachments`.
- Stage vocabulary: `system/pipeline-stages.yaml`.
- Action register: `state/action-register.md` (managed via
  `scripts/register.js` — never hand-edit IDs).
- Tracked items: `state/pipeline/*.yaml`.

## Procedure
1. List admitted files in `inbox/` (ignore `archive/`, `quarantine/`, `drop/`,
   the `.text/` directory, and the `.flags.json` / `.vision-pending.json`
   sidecars themselves).
2. For each file, read its `.flags.json` and branch on `extraction.scan_state`:
   - `vision-pending`: SKIP for now. It has no usable text until interpreted.
     Report it as "awaiting vision interpretation" and leave it in `inbox/`.
   - `unscanned`: report that it could not be read as text; do not guess its
     contents. Leave it for the operator.
   - `scanned`: proceed to classify. If `extraction.text_file` is set, READ that
     file for the contents -- it is the extraction intake already made, and for a
     pdf, docx, xlsx, eml or image it is the ONLY readable form. Do not open the
     binary itself.
3. If `tripwire.flagged` is true, note the flag in your summary for that item.
   Do not quote the flagged content back; the egress gate governs what the
   model may emit.
4. Classify each scanned item as one of: `action`, `info`, `discard`.
5. For an `action` item, PROPOSE an action-register entry: show the exact
   command you would run, e.g.
   `node scripts/register.js add "<description>" --owner <owner> --estimate <2w|3d|...> --pipeline <stage>`
   Do NOT run it yet. Present all proposed additions together and ask for
   confirmation. On explicit confirmation, run each command (the CLI assigns the
   next ID deterministically and computes the due date).
6. If an item affects a tracked pipeline item, PROPOSE the edit to the matching
   `state/pipeline/<id>.yaml` as a shown unified diff. Apply only on explicit
   confirmation. Choose `stage` values only from `system/pipeline-stages.yaml`.
7. After the operator confirms handling of an item, move that file (and its
   sidecars) to `inbox/archive/`. Items classified `info` or `discard` are
   archived once acknowledged.

## Output
- To chat: a per-item classification with proposed actions, then the set of
  proposed writes for confirmation. Nothing is written before confirmation.

## Refusal / guardrails
- Propose, don't mutate. No write to the action register or pipeline before
  explicit operator confirmation.
- Never process a `vision-pending` item as if it had text.
- Never send anything externally. Never output PII.
- Respect every rule in CLAUDE.md.
