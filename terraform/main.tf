data "azurerm_client_config" "current" {}

# Suffix for globally-unique names (Key Vault, storage account).
resource "random_string" "suffix" {
  length  = 5
  lower   = true
  numeric = true
  upper   = false
  special = false
}

locals {
  suffix = random_string.suffix.result

  rg_name   = "${var.prefix}-rg"
  vm_name   = "${var.prefix}-vm"
  vnet_name = "${var.prefix}-vnet"
  nsg_name  = "${var.prefix}-nsg"
  nic_name  = "${var.prefix}-nic"
  uai_name  = "${var.prefix}-identity"
  kv_name   = "${var.prefix}-kv-${local.suffix}"  # <=24 chars given prefix validation
  sa_name   = "${var.prefix}sa${local.suffix}"    # alphanumeric only

  repo_name    = coalesce(var.scaffold_repo_name, "${var.prefix}-scaffold")
  app_hostname = "${coalesce(var.app_subdomain, var.prefix)}.${var.cloudflare_zone_name}"
  ssh_hostname = "${coalesce(var.ssh_subdomain, "ssh-${var.prefix}")}.${var.cloudflare_zone_name}"

  scaffold_dir = "${path.module}/../scaffold"

  # Names of the Key Vault secrets the VM fetches at boot.
  kv_secret_tunnel_token = "tunnel-token"
  kv_secret_deploy_key   = "scaffold-deploy-key"
}

resource "azurerm_resource_group" "main" {
  name     = local.rg_name
  location = var.location
  tags     = var.tags
}
