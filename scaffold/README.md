# Scaffold — Personal AI Operations Platform (Structural Twin)

This repository is the deployed filesystem for a structural twin of a
first-generation personal AI operations platform. It is pushed by Terraform
and cloned onto the VM at first boot.

**It contains structure only.** Every script is a stub, every skill is a
skeleton, and every state directory is empty. See PLAYBOOK.md in the
infrastructure repository for the ordered path from scaffold to operational.

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
