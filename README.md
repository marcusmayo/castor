# Personal AI Operations Platform — Structural Twin (IaC)

Terraform that provisions a **digital twin of the structure** of a
first-generation personal AI operations platform: the infrastructure, the
hardened host, and the application filesystem skeleton. One `apply` produces
a boot-to-shaped system. It contains **no data and no behavioral content** —
every script is a stub and every state directory is empty.

Provenance: the architecture reproduces a first-generation personal system
that was designed, built, and hardened to a 9/9 GREEN compliance posture.
This twin stands on fully separate infrastructure, with the secrets layer
deliberately modernized (Key Vault + managed identity replacing host-local
encryption).

## Architecture

```
Operator devices
      │  Cloudflare Tunnel (outbound-only, zero-trust)
      ▼
Azure VM (Ubuntu 24.04, Standard_B2ms, no public IP, deny-all NSG)
  ├── sshd bound to 127.0.0.1 (systemd ssh.socket override)
  ├── Node 22 LTS · Claude Code · cloudflared · fail2ban · unattended-upgrades
  ├── User-assigned managed identity
  │       ├── Key Vault  (Secrets User)  ← tunnel token, deploy key,
  │       │                                 operator-supplied API secrets
  │       └── Storage    (Blob Data Contributor) ← backup target
  └── ~/<prefix>/  ← cloned at boot from a private GitHub scaffold repo
       CLAUDE.md · .claude/commands/ · scripts/(13 stubs) · state/ ·
       knowledge/ · System/ · inbox/ · logs/ · crontab.template (inactive)
```

Terraform manages three providers in one graph: **azurerm** (VM, network,
Key Vault, storage), **cloudflare** (tunnel, ingress config, DNS), and
**github** (private scaffold repo, contents, read-only deploy key).

## Repository layout

```
terraform/    the template (state: remote Azure blob backend, day one)
scaffold/     source of the deployed tree — pushed to its own repo by apply
PLAYBOOK.md   prerequisites, apply sequence, post-apply steps, gap register,
              and the ordered path from scaffold to operational
```

## Quick start

1. Read `PLAYBOOK.md` §1–2 (credentials + one-time state backend bootstrap).
2. `cp terraform/terraform.tfvars.example terraform/terraform.tfvars` and fill in.
3. `cd terraform && terraform init -backend-config=backend.hcl`
4. `terraform plan`, then `terraform apply`.
5. `PLAYBOOK.md` §5–6: populate operator secrets, verify the tunnel.

## Security posture notes

- No public IP; explicit deny-all inbound NSG; SSH reachable only through the
  tunnel and bound to localhost.
- No credential values appear in code or tfvars. Provider auth is
  environment-only; operator secrets go straight into Key Vault post-apply.
- The tunnel run token is cached in Terraform state (Terraform creates the
  tunnel) — this is inherent, and it is why state lives in an encrypted,
  access-controlled remote backend from day one. Treat backend access as
  credential-equivalent.
- Deliberate demo-posture choices, each flagged for hardening in
  `PLAYBOOK.md` §11: Key Vault purge protection off, storage shared-key
  access left enabled (identity-only on the VM regardless), Claude Code
  version unpinned by default.
