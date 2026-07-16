# ----------------------------------------------------------------- identity
variable "subscription_id" {
  description = "Azure subscription ID to deploy into."
  type        = string
}

variable "prefix" {
  description = "Short resource prefix. Nothing system-specific is hardcoded; this names everything."
  type        = string
  default     = "twin"
  validation {
    condition     = can(regex("^[a-z][a-z0-9]{2,11}$", var.prefix))
    error_message = "prefix must be 3-12 chars, lowercase alphanumeric, starting with a letter (storage-account safe)."
  }
}

variable "location" {
  description = "Azure region."
  type        = string
  default     = "eastus"
}

variable "tags" {
  description = "Tags applied to every Azure resource."
  type        = map(string)
  default = {
    managed_by = "terraform"
    workload   = "personal-ai-ops-twin"
  }
}

# ------------------------------------------------------------------ compute
variable "vm_size" {
  description = "VM size. Default B2ms (2 vCPU / 8 GB — matches original RAM). Swap here if the region lacks stock: az vm list-skus -l <region> --size Standard_B2 -o table"
  type        = string
  default     = "Standard_B2ms"
}

variable "admin_username" {
  description = "VM admin user. SSH key-only; password auth disabled by cloud-init."
  type        = string
  default     = "opsadmin"
}

variable "admin_ssh_public_key" {
  description = "OpenSSH public key for the admin user (contents of your .pub file)."
  type        = string
}

variable "node_major" {
  description = "Node.js major version installed via NodeSource. 22+ required by the Claude Code npm package as of v2.1.198."
  type        = string
  default     = "22"
}

variable "claude_code_version" {
  description = "Claude Code npm dist-tag or exact version. Pin an exact version for production posture (see PLAYBOOK.md §11)."
  type        = string
  default     = "latest"
}

# --------------------------------------------------------------- cloudflare
variable "cloudflare_account_id" {
  description = "Cloudflare account ID (dashboard: any zone -> Overview, right rail)."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Zone ID of the domain that will front the tunnel."
  type        = string
}

variable "cloudflare_zone_name" {
  description = "Zone name (e.g. example.com). Used only to compose hostnames."
  type        = string
}

variable "app_subdomain" {
  description = "Subdomain for the web interface. Defaults to prefix."
  type        = string
  default     = null
}

variable "ssh_subdomain" {
  description = "Subdomain for SSH-over-tunnel. Defaults to ssh-<prefix>."
  type        = string
  default     = null
}

# ------------------------------------------------------------------- github
variable "github_owner" {
  description = "GitHub user or org that will own the scaffold repository."
  type        = string
}

variable "scaffold_repo_name" {
  description = "Name of the scaffold repository Terraform creates. Defaults to <prefix>-scaffold."
  type        = string
  default     = null
}
