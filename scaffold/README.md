# Scaffold — Personal AI Operations Platform (Structural Twin)

This repository is the deployed filesystem for a structural twin of a
first-generation personal AI operations platform. It is pushed by Terraform
and cloned onto the VM at first boot.

The scripts and skills are implemented and tested; the state and knowledge
directories are empty by design, so a fresh deploy stands up clean and
generic. See PLAYBOOK.md in the infrastructure repository for the ordered path
from scaffold to operational.

Layout mirrors the original architecture:

    CLAUDE.md            behavioral framework (skeleton)
    MEMORY.md            dynamic context summary (empty)
    .claude/commands/    skill library (6 skeletons)
    scripts/             13 automation stubs
    state/pipeline/      YAML item files — one per tracked project / use case
    state/               action register, logs, draft queue (empty)
    knowledge/           reference pages (empty)
    System/              operator, voice, and model-routing profiles (placeholders)
    inbox/               incoming message queue (empty)
    logs/                runtime logs (empty)
    crontab.template     full cron schedule — NOT installed by default

## Changing the model

Model routing is defined in `System/model-routing.yaml` and is the single
source of truth for both the model `claude -p` requests and the OpenRouter
model it maps to. Change a model with one command — no code edit, no restart
(the change takes effect on the next call):

    # see the current routing
    node scripts/model-routing.js list

    # point a tier at a different OpenRouter model
    node scripts/model-routing.js set complex --slug openrouter/anthropic/claude-3.7-sonnet

    # optionally also change the alias claude -p requests
    node scripts/model-routing.js set routine --name claude-sonnet-4-5 --slug openrouter/moonshotai/kimi-k3

Tiers: `triage` (fast), `routine` (default), `complex` (frontier). Verify
current OpenRouter slugs at https://openrouter.ai/api/v1/models before
changing. The LiteLLM gateway config is generated from this file
(`node scripts/model-routing.js gateway-config`), so the gateway can never
drift from the policy. The running webchat also shows the active model and this
command in its header.
