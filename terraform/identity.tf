# User-assigned (not system-assigned) managed identity — deliberate.
# System-assigned would create a boot-time race: the identity only exists after
# the VM does, so its Key Vault role assignment could not exist before first
# boot tries to fetch secrets. User-assigned lets us grant roles BEFORE the VM
# is created. cloud-init still retries fetches to absorb RBAC propagation lag.

resource "azurerm_user_assigned_identity" "vm" {
  name                = local.uai_name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags
}

# VM identity: read secrets.
resource "azurerm_role_assignment" "vm_kv_secrets_user" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.vm.principal_id
}

# VM identity: write backups (identity-based data plane; no account keys on the VM).
resource "azurerm_role_assignment" "vm_storage_blob" {
  scope                = azurerm_storage_account.backup.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.vm.principal_id
}

# Deployer: needs data-plane write to create the two Terraform-managed secrets.
# NOTE: creating role assignments requires Owner or User Access Administrator
# on the subscription/RG — see PLAYBOOK.md §1.
resource "azurerm_role_assignment" "deployer_kv_secrets_officer" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

# RBAC propagation is eventually consistent; without this pause the first
# apply intermittently fails writing secrets. Known-good pattern.
resource "time_sleep" "rbac_propagation" {
  create_duration = "90s"
  depends_on = [
    azurerm_role_assignment.deployer_kv_secrets_officer,
    azurerm_role_assignment.vm_kv_secrets_user,
    azurerm_role_assignment.vm_storage_blob,
  ]
}
