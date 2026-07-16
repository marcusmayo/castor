resource "azurerm_key_vault" "main" {
  name                = local.kv_name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard"
  tags                = var.tags

  rbac_authorization_enabled = true

  # Demo posture: purge protection OFF so terraform destroy is clean.
  # Flip to true (and remove purge_soft_delete_on_destroy in providers.tf)
  # for a durable deployment. Flagged in PLAYBOOK.md §11.
  purge_protection_enabled   = false
  soft_delete_retention_days = 7
}

# --- Terraform-managed secrets (values Terraform itself generates/obtains) ---

# Tunnel run token: Cloudflare -> Key Vault -> fetched by the VM at boot.
resource "azurerm_key_vault_secret" "tunnel_token" {
  name         = local.kv_secret_tunnel_token
  value        = data.cloudflare_zero_trust_tunnel_cloudflared_token.main.token
  key_vault_id = azurerm_key_vault.main.id
  content_type = "cloudflared tunnel run token"
  depends_on   = [time_sleep.rbac_propagation]
}

# Read-only deploy key: lets the VM clone the private scaffold repo.
resource "azurerm_key_vault_secret" "scaffold_deploy_key" {
  name         = local.kv_secret_deploy_key
  value        = tls_private_key.deploy.private_key_openssh
  key_vault_id = azurerm_key_vault.main.id
  content_type = "OpenSSH private key (read-only deploy key)"
  depends_on   = [time_sleep.rbac_propagation]
}

# --- Operator-supplied secrets are NOT created here ---
# anthropic-api-key, telegram-bot-token, telegram-chat-id, totp-secret,
# resend-api-key, mail-poll-user, mail-poll-pass
# are populated post-apply via `az keyvault secret set` (PLAYBOOK.md §5),
# so real credential values never pass through Terraform code or state.
