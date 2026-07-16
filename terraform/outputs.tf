output "resource_group" {
  value = azurerm_resource_group.main.name
}

output "vm_name" {
  value = azurerm_linux_virtual_machine.main.name
}

output "vm_private_ip" {
  value = azurerm_network_interface.main.private_ip_address
}

output "identity_client_id" {
  description = "User-assigned managed identity client ID (used by IMDS fetches on the VM)."
  value       = azurerm_user_assigned_identity.vm.client_id
}

output "key_vault_name" {
  value = azurerm_key_vault.main.name
}

output "key_vault_uri" {
  value = azurerm_key_vault.main.vault_uri
}

output "backup_storage_account" {
  value = azurerm_storage_account.backup.name
}

output "scaffold_repo" {
  value = github_repository.scaffold.html_url
}

output "tunnel_id" {
  value = cloudflare_zero_trust_tunnel_cloudflared.main.id
}

output "app_url" {
  description = "Web interface hostname. Returns 502 until scripts/webchat.js is implemented — expected."
  value       = "https://${local.app_hostname}"
}

output "ssh_hostname" {
  description = "SSH-over-tunnel hostname. Client config in PLAYBOOK.md §6."
  value       = local.ssh_hostname
}

output "next_steps" {
  value = "Populate operator secrets in Key Vault, then verify the tunnel — PLAYBOOK.md §5-6."
}
