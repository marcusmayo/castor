# Draft Queue — Canonical State Vocabulary

| State | Meaning |
|---|---|
| DRAFTED | Created, awaiting operator review |
| APPROVED | Operator approved; moved to state/approved-drafts/ |
| SENT | Operator manually delivered externally |
| DISCARDED | Operator rejected |

Review verdicts during the loop: **SENT** · **HOLD** · **EDITS: [changes]** · **DISCARD**

Hard rule: SENT is always a manual, operator-performed action. The system
never delivers externally — send-email.js is operator notifications only.
