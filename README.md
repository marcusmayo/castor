# Castor - a generic, deterministic-first AI agent

Castor is the application layer of a structural twin of a first-generation
personal AI operations platform: an isolated, auditable agent whose scripts and
skills are implemented and tested, with every state and knowledge directory
empty by design so a fresh deploy stands up clean and generic. It carries no
data and no behavioral content of the original - only the shape.

The agent code lives in `scaffold/`. It is deployed as a fleet profile by
**fleet** (Bicep + user-assigned managed identity):
https://github.com/marcusmayo/fleet

A self-contained **Terraform** deployment of the same twin (one `apply`, three
providers, pushes this scaffold into its own repo) is preserved separately at:
https://github.com/marcusmayo/castor-tf-iac

## Run it locally

Production auth is edge-only (Cloudflare Access); the app 403s anything that
didn't come through it. For a laptop there is an explicit local mode:

Prerequisite: Docker Desktop running (Windows/macOS) or the docker engine
(Linux). The commands below are identical on all three — PowerShell included.

```bash
git clone https://github.com/marcusmayo/castor.git
cd castor/scaffold/infra/docker
cp castor.env.example castor.env
#   set  ANTHROPIC_API_KEY=sk-ant-...      (or an sk-or- key with the gateway profile)
#   uncomment  AUTH_MODE=local             (local development ONLY)
docker compose --env-file ../versions.lock up -d --build webchat
# open http://127.0.0.1:8443
```

The `--env-file` feeds the repo's pinned versions into the image build — the
build still fails if the vendored core drifts from its manifest. (On the
fleet's own VMs the image is built by `infra/scripts/build-image.sh` instead;
this path is for laptops.)

`AUTH_MODE=local` disables edge authentication entirely: default-off, only the
literal word activates it, read at request time so an image can never bake it
on, and every page carries a permanent red banner. Never expose that port to a
network. Unset, behaviour is byte-identical to production — a bare request
gets 403 — and a test pins that.

## Architecture

Castor runs as a hardened container agent behind a Cloudflare Tunnel, with the
secrets layer on Key Vault + managed identity (no host-local credentials).

- **Deterministic-first.** Mechanical work - parsing, matching, scoring, YAML
  state - runs in pure Python/Node tools; the model is invoked only for genuine
  semantic ambiguity.
- **Keyless gateway.** Every model call routes through a LiteLLM gateway that
  injects the provider key per call; the agent container holds no upstream key.
- **Egress-gated.** Sensitive content is flagged by a tripwire before it can
  leave; the gate sends only redacted text to the model via `claude -p`.
- **Propose-don't-mutate.** The agent drafts; the operator creates or modifies
  load-bearing state. Deletes are operator-explicit.

```
scaffold/
  gate/          egress tripwire + claude -p spine (redact, audit)
  scripts/       intake, register, digest, model-routing, health, scan-tree, ...
  webchat/       auth + pending panel + interpret actions
  System/        capabilities, model-routing.yaml, pipeline stages, voice
  tests/         fixture tests for the intake / skill lanes
  infra/         Dockerfile, compose, bootstrap (managed-identity first-boot)
  run_e2e.sh     end-to-end acceptance oracle
  clean_demo.sh  reset demo state to a clean agent
```

## Deploy

Castor deploys through the fleet, not from this repo directly. See
**fleet** for the one-command path: `deploy.sh` provisions the VM and
per-agent Key Vault, `set-secrets.sh` sets the operator secrets with shape
validation, and `bootstrap.sh` fetches them via managed identity and brings the
stack up. Run the acceptance oracle on a fresh agent to prove the pipeline:

    docker exec -w /app castor-webchat bash run_e2e.sh --yes

The standalone Terraform twin (single `apply`, remote state, no fleet) lives at
https://github.com/marcusmayo/castor-tf-iac.

## Security posture

- No public IP; deny-all inbound NSG; SSH reachable only through the tunnel and
  bound to localhost.
- No credential values in code. Provider/agent auth is environment- and
  identity-only; operator secrets go straight into Key Vault.
- The agent container is keyless - the LiteLLM gateway injects the upstream key
  per call, and the egress gate flags sensitive content before it leaves.
