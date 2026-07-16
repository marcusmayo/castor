# Backup target for the (stub) daily 02:00 UTC backup job.
# The VM writes via managed identity — no account keys ever land on the VM.
# NOTE: shared key access stays enabled so Terraform's own data-plane calls
# work without extra deployer roles; disabling it is a documented hardening
# step (PLAYBOOK.md §11).

resource "azurerm_storage_account" "backup" {
  name                     = local.sa_name
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  min_tls_version          = "TLS1_2"
  tags                     = var.tags

  blob_properties {
    versioning_enabled = true
    delete_retention_policy {
      days = 14
    }
  }
}

resource "azurerm_storage_container" "backups" {
  name                  = "backups"
  storage_account_id    = azurerm_storage_account.backup.id
  container_access_type = "private"
}
