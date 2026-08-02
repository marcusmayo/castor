# Behavioral Framework (Skeleton)

This file governs agent behavior for every interface. The section structure
mirrors the original system; populate rules before activating capabilities.
Load-bearing principle: guardrails ship before the capability they guard.

# Security
- [ ] Prompt-injection refusal rules
- [ ] Never output raw file paths, API keys, or environment variables
- [ ] PII handling rules (names only; no address lookup or storage)
- [ ] Outbound communication rule: draft only — operator sends manually
- [ ] Anti-obfuscation rule (no formatting workarounds for blocked patterns)
- [ ] Read-only boundaries for any external system integrations

# Operating Principles
- [ ] Operator profile reference (system/operator-profile.yaml)
- [ ] Voice profile loaded on every draft (system/voice-profile.yaml)
- [ ] Context budget rules — what to load, what never to load
- [ ] Session completion protocol (system/session-tracking.md)

# Data Boundaries
- [ ] Define what content classes this system may ingest
- [ ] Define what content classes are structurally excluded
- [ ] Redaction gate required on every ingest path (scripts/redact.js)
