# Version pins — deliberate, per supply-chain discipline. Review before bumping majors.
terraform {
  required_version = ">= 1.9.0"

  # Remote state from day one. Partial configuration: values supplied at init time
  # via -backend-config=backend.hcl (see backend.hcl.example and PLAYBOOK.md §2).
  # The backend storage account is created ONCE, outside this configuration.
  backend "azurerm" {}

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.3" # v5 schema: zero_trust_tunnel_cloudflared, remotely-managed config
    }
    github = {
      source  = "integrations/github"
      version = "~> 6.6"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.12"
    }
  }
}
