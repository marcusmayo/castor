# Credentials are NEVER declared in code or tfvars:
#   Azure      -> az login (or ARM_* environment variables)
#   Cloudflare -> CLOUDFLARE_API_TOKEN environment variable
#   GitHub     -> GITHUB_TOKEN environment variable
# Required token scopes are documented in PLAYBOOK.md §1.

provider "azurerm" {
  features {
    key_vault {
      # Demo posture: allow clean terraform destroy. Flip for durable deployments.
      purge_soft_delete_on_destroy    = true
      recover_soft_deleted_key_vaults = true
    }
  }
  subscription_id = var.subscription_id # explicit — required by azurerm 4.x
}

provider "cloudflare" {
  # api_token read from CLOUDFLARE_API_TOKEN
}

provider "github" {
  owner = var.github_owner
  # token read from GITHUB_TOKEN
}
