# Zero-trust access layer. Provider v5 schema (remotely-managed tunnel):
# Cloudflare generates and holds the tunnel credential; we read the run token
# and route it to the VM through Key Vault. The token is sensitive and WILL be
# cached in Terraform state — one of the reasons state lives in an encrypted,
# access-controlled remote backend (README.md, security notes).

resource "cloudflare_zero_trust_tunnel_cloudflared" "main" {
  account_id = var.cloudflare_account_id
  name       = "${var.prefix}-tunnel"
  config_src = "cloudflare" # remotely managed — config lives in Cloudflare, declared below
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "main" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.main.id
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "main" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.main.id

  config = {
    # Global origin keepalive — mirrors the as-used fix: agent runs >80s
    # dropped the tunnel until keepalive was raised to 300s. v5 schema takes
    # integer seconds (v4 took duration strings). Pair with app-level
    # ping layers when webchat.js is implemented (server 10s / client 15s).
    origin_request = {
      keep_alive_timeout     = 300
      tcp_keep_alive         = 30
      keep_alive_connections = 100
    }

    ingress = [
      {
        # Web interface. Serves 502 until scripts/webchat.js is implemented
        # and listening on localhost:3000 — expected pre-implementation state.
        hostname = local.app_hostname
        service  = "http://localhost:3000"
      },
      {
        # SSH-over-tunnel. Client side: `cloudflared access ssh` ProxyCommand
        # (PLAYBOOK.md §6). Pairs with sshd bound to 127.0.0.1 on the VM.
        hostname = local.ssh_hostname
        service  = "ssh://localhost:22"
      },
      {
        service = "http_status:404" # catch-all
      },
    ]
  }
}

resource "cloudflare_dns_record" "app" {
  zone_id = var.cloudflare_zone_id
  name    = local.app_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.main.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "ssh" {
  zone_id = var.cloudflare_zone_id
  name    = local.ssh_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.main.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}
