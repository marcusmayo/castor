locals {
  cloud_init = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    admin_username         = var.admin_username
    prefix                 = var.prefix
    key_vault_name         = azurerm_key_vault.main.name
    kv_secret_tunnel_token = local.kv_secret_tunnel_token
    kv_secret_deploy_key   = local.kv_secret_deploy_key
    msi_client_id          = azurerm_user_assigned_identity.vm.client_id
    repo_ssh_url           = github_repository.scaffold.ssh_clone_url
    node_major             = var.node_major
    claude_code_version    = var.claude_code_version
  })
}

resource "azurerm_linux_virtual_machine" "main" {
  name                = local.vm_name
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  size                = var.vm_size
  admin_username      = var.admin_username
  tags                = var.tags

  network_interface_ids = [azurerm_network_interface.main.id]

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.admin_ssh_public_key
  }

  disable_password_authentication = true

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = 64
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.vm.id]
  }

  custom_data = base64encode(local.cloud_init)

  # First boot fetches secrets, clones the repo, and starts the tunnel —
  # so everything it touches must exist before the VM does.
  depends_on = [
    azurerm_key_vault_secret.tunnel_token,
    azurerm_key_vault_secret.scaffold_deploy_key,
    azurerm_role_assignment.vm_kv_secrets_user,
    azurerm_role_assignment.vm_storage_blob,
    github_repository_file.scaffold,
    github_repository_deploy_key.scaffold_ro,
    cloudflare_zero_trust_tunnel_cloudflared_config.main,
    cloudflare_dns_record.app,
    cloudflare_dns_record.ssh,
    azurerm_storage_container.backups,
  ]
}
