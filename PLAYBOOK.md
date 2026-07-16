# PLAYBOOK — From Zero to Structural Twin to Operational

This is the operating document for the twin. §1–6 get you from nothing to a
deployed, verified structure. §7 is the honest gap register — everything the
template deliberately does **not** do. §8 is the ordered path from structure
to a functioning system.

---

## §1 Prerequisites

**Tools (workstation):** Terraform ≥ 1.9 · Azure CLI · git

**Accounts:** an Azure subscription (fresh/separate), a Cloudflare account
with a zone (domain) on it, a GitHub account or org.

**Credentials — environment only, never in files:**

| Provider | How | Required scope |
|---|---|---|
| Azure | `az login` (Terraform inherits the session) | **Owner** or Contributor **+ User Access Administrator** on the subscription — this template creates role assignments, which plain Contributor cannot |
| Cloudflare | `export CLOUDFLARE_API_TOKEN=...` | Account → **Cloudflare Tunnel: Edit**; Zone → **DNS: Edit** (scoped to the target zone). Note: the permission is named "Cloudflare Tunnel," not "Zero Trust" |
| GitHub | `export GITHUB_TOKEN=...` | Classic PAT: `repo` scope. Fine-grained: Repository **Administration: RW** + **Contents: RW** (repo creation + deploy keys + file pushes) |

Gather these values for `terraform.tfvars`: subscription ID, Cloudflare
account ID and zone ID (zone Overview page, right rail), zone name, GitHub
owner, and your SSH public key.

**VM size availability** (default `Standard_B2ms`):

```
az vm list-skus --location eastus --size Standard_B2 --output table
```

If unavailable, set `vm_size` in tfvars — one-line swap, nothing else changes.

## §2 One-time state backend bootstrap

The remote state backend cannot be created by the configuration that uses it.
Run once, ever:

```
az group create -n tfstate-rg -l eastus
az storage account create -n tfstate$RANDOM -g tfstate-rg -l eastus \
  --sku Standard_LRS --min-tls-version TLS1_2
az storage account blob-service-properties update \
  --account-name <name-from-above> -g tfstate-rg --enable-versioning true
az storage container create --account-name <name-from-above> -n tfstate \
  --auth-mode login
```

Copy `terraform/backend.hcl.example` → `terraform/backend.hcl`, fill in the
account name. Blob versioning gives you state history; the backend uses Azure
AD auth (`use_azuread_auth = true`) — you may need **Storage Blob Data
Contributor** on that account for your own principal:

```
az role assignment create --assignee <your-object-id> \
  --role "Storage Blob Data Contributor" \
  --scope $(az storage account show -n <name> -g tfstate-rg --query id -o tsv)
```

## §3 Configure

```
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
# fill in; tfvars and backend.hcl are gitignored
export CLOUDFLARE_API_TOKEN=...
export GITHUB_TOKEN=...
az login
```

## §4 Apply

```
cd terraform
terraform init -backend-config=backend.hcl
terraform plan     # expect ~55 resources (≈35 are scaffold file pushes)
terraform apply
```

Apply includes a deliberate 90-second pause (`time_sleep.rbac_propagation`)
— RBAC role assignments are eventually consistent. First boot then takes
5–10 minutes: watch `az vm run-command` or wait and verify per §6.

**Resize on demand.** The VM is vertically elastic in both directions: edit
`vm_size` in tfvars and `terraform apply` — azurerm resizes in place with a
~3–5 minute restart. No public IP or DNS is disturbed, the tunnel reconnects
on boot, and cloud-init does not re-run. Resize back the same way after the
heavy session. Avoid `az vm resize` directly — it drifts state. B2ms banks
CPU credits while idle; bump to `Standard_D2s_v3` only for sustained
multi-hour agent sessions.

## §5 Post-apply: populate operator secrets

Terraform created two secrets (tunnel token, deploy key). The rest are yours
to supply — they never pass through Terraform code or state:

```
KV=$(terraform output -raw key_vault_name)
az keyvault secret set --vault-name $KV -n anthropic-api-key    --value '...'
az keyvault secret set --vault-name $KV -n telegram-bot-token   --value '...'
az keyvault secret set --vault-name $KV -n telegram-chat-id     --value '...'
az keyvault secret set --vault-name $KV -n totp-secret          --value '...'
az keyvault secret set --vault-name $KV -n resend-api-key       --value '...'
az keyvault secret set --vault-name $KV -n mail-poll-user       --value '...'
az keyvault secret set --vault-name $KV -n mail-poll-pass       --value '...'
```

How to obtain each: Anthropic key — provider console (rotate any key that has
ever appeared on screen or in a paste buffer). Telegram — create the bot via
@BotFather first; chat ID from your first message to it. TOTP — generate a
base32 seed and enroll it in your authenticator before webchat is implemented.
Resend — dashboard API key, after domain verification. Mail poll — an app
password from your mail provider, never your primary password.

On the VM, anything can read these at runtime via the installed helper:

```
/opt/twin-bootstrap/fetch-secret.sh anthropic-api-key
```

## §6 Verify

On the VM won't work yet — you have no path in except the tunnel, which is the
point. From your workstation:

1. **Tunnel healthy:** Cloudflare dashboard → Zero Trust → Networks → Tunnels
   → `<prefix>-tunnel` shows HEALTHY.
2. **SSH over tunnel:** install `cloudflared` locally, then in `~/.ssh/config`:

   ```
   Host twin
     HostName <ssh_hostname output>
     User <admin_username>
     ProxyCommand cloudflared access ssh --hostname %h
   ```

   `ssh twin` should land you at the MOTD breadcrumb.
3. **On the VM:** `cloud-init status` → `done`; review
   `/var/log/twin-bootstrap.log`; `systemctl status cloudflared fail2ban`;
   `ss -tlnp | grep 127.0.0.1:22` (localhost binding took);
   `ls ~/<prefix>` (scaffold cloned); `claude --version`.
4. **Web hostname:** `https://<app_url output>` returns **502 — expected.**
   Nothing listens on :3000 until `webchat.js` is implemented (§8).

## §7 Gap register — what the template deliberately does NOT do

| Component | State after apply | Remaining work |
|---|---|---|
| 13 scripts in `scripts/` | Named stubs, header-documented | Implement (§8 order) |
| 6 skills in `.claude/commands/` | Skeletons (incl. compliance-report) | Author procedures + guardrails |
| Pipeline tracking | `state/pipeline/` + item schema; /pipeline and /triage spec'd against it | Author real item YAMLs; implement any batch processing beyond skill-driven reads |
| CLAUDE.md | Section skeleton, empty rules | Populate **before** activating any capability |
| Operator/voice profiles | Placeholder fields | Build voice profile from a real approved-draft corpus |
| Crontab | `crontab.template` shipped, **not installed** | Activate only after referenced scripts exist |
| Webchat | Tunnel ingress exists; no listener | Implement `webchat.js` incl. TOTP; 502 until then |
| Telegram bot | Nothing | Create via BotFather; store token/chat-id (§5) |
| Email accounts | Nothing | Provision review mailbox + outbound provider; store creds (§5) |
| TOTP | Nothing | Generate seed, enroll authenticator, store (§5) |
| Backup | Storage + RBAC live; script is a stub | Implement identity-based `azcopy` in `azure-backup.sh` |
| Backup encryption | Storage-side encryption only | Decision pending: client-side encryption before upload (original pattern) vs storage-side only |
| Attachments/images | Inbox specs are text-only | Decision pending: attachment fallback in poller + webchat specs (was a used feature) |
| /morning calendar source | Undefined — true of the original too | Decision pending: operator-authored note vs external integration |
| Claude Code auth | Installed, unauthenticated | Runtime pattern: scripts export `ANTHROPIC_API_KEY=$(fetch-secret.sh anthropic-api-key)` |
| Compliance layer | Not present | Optional modular layer, sequenced last — by design |

## §8 Ordered path from structure to operational

Guardrails before capabilities — this ordering is load-bearing. Note the
tracking layer needs no code: copy `state/pipeline/_item-template.yaml` per
use case and /pipeline has data to read as soon as the skill is authored.

1. Populate CLAUDE.md security rules and data-boundary sections.
2. Implement `redact.js` (ingest gate) and `redaction-gate.js`; install the
   pre-commit hook. **No ingest path ships before the gate exists.**
3. Implement `audit-log.js`; wire it into every model call from day one.
4. Implement `webchat.js` (TOTP from Key Vault) — first interface live.
5. Implement `email-poller.js` (through the ingest gate) and `send-email.js`
   (operator notifications only — the never-send-external rule is already in
   the stub header; keep it).
6. Implement `telegram-bot.js` with the single-chat-ID allow list.
7. Implement `digest.js`, `health-check.js`, `sunday-maintenance.py`,
   `pii-weekly-scan.sh`, `log-rotate.sh`, `azure-backup.sh`.
8. Edit `crontab.template` paths, then activate:
   `crontab ~/<prefix>/crontab.template`.
9. Build the voice profile from real drafts; populate operator profile.
10. Optional hardening + compliance layer (§11).

## §9 Kill switch (parity with the original: < 60 seconds, three steps)

1. `az vm deallocate -g <prefix>-rg -n <prefix>-vm --no-wait`
2. Revoke the model API key (provider console).
3. Cloudflare dashboard → Tunnels → disable/delete `<prefix>-tunnel`.

Zero data moves, zero processing occurs. Rehearse it before you need it.

**Restore (target < 6 minutes, parity with the original rehearsal):**

1. `az vm start -g <prefix>-rg -n <prefix>-vm`
2. Re-enable the tunnel in the dashboard (if disabled rather than deleted,
   the token is unchanged and cloudflared reconnects on boot).
3. Rotate/restore the model API key:
   `az keyvault secret set --vault-name <kv> -n anthropic-api-key --value '...'`
4. Verify per §6: tunnel HEALTHY, services up, localhost SSH binding.

Full-loss rebuild: `terraform apply` recreates infrastructure and re-clones
the scaffold; §5 re-populates secrets; working-tree data returns from the
backups container once `azure-backup.sh` is implemented — until then, data
recovery depends on the working tree's own git pushes. Rehearse both paths.

## §10 Teardown

`terraform destroy` removes everything including the scaffold repo (its
history dies with it — export first if you care). Key Vault purge protection
is off, so destroy is clean. The state backend RG (`tfstate-rg`) persists by
design; delete manually if fully retiring the deployment.

## §11 Hardening backlog (deliberate demo-posture deferrals)

- Pin `claude_code_version` to an exact release; verify against the signed
  release manifest (each release publishes SHA256 checksums).
- Enable Key Vault purge protection; remove `purge_soft_delete_on_destroy`.
- Disable storage shared-key access + set `storage_use_azuread = true` in the
  provider (requires deployer data-plane role).
- Put a Cloudflare Access application in front of both hostnames — identity
  at the edge, ahead of TOTP at the app.
- Split state per environment (workspaces or directories) when a second
  deployment context appears.
- Add an `azurerm_consumption_budget_resource_group` alert — the original
  workflow managed cost actively (tiered routing); make the twin self-reporting.
