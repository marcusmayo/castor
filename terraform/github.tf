# The scaffold repo is the source of truth for the deployed tree.
# Terraform creates it, pushes every file under ../scaffold, and registers a
# read-only deploy key. The VM clones it at first boot. Scaffold changes are
# therefore commits + apply — never edits buried inside cloud-init.

resource "github_repository" "scaffold" {
  name        = local.repo_name
  description = "Deployed filesystem scaffold — structural twin, pushed by Terraform."
  visibility  = "private"
  auto_init   = true # creates main so repository_file has a branch to target

  has_issues   = false
  has_wiki     = false
  has_projects = false
}

# Read-only deploy key; private half travels VM-ward via Key Vault only.
resource "tls_private_key" "deploy" {
  algorithm = "ED25519"
}

resource "github_repository_deploy_key" "scaffold_ro" {
  repository = github_repository.scaffold.name
  title      = "${var.prefix}-vm read-only clone key"
  key        = tls_private_key.deploy.public_key_openssh
  read_only  = true
}

locals {
  # Terraform's fileset uses Go glob semantics (dotfiles are matched by *),
  # but we union explicit dot-path patterns anyway so .claude/** and .gitkeep
  # files can never silently drop out of the push. Redundancy is deliberate.
  scaffold_files = setunion(
    fileset(local.scaffold_dir, "**"),
    fileset(local.scaffold_dir, ".*/**"),
    fileset(local.scaffold_dir, "**/.gitkeep"),
  )
}

resource "github_repository_file" "scaffold" {
  for_each = local.scaffold_files

  repository          = github_repository.scaffold.name
  branch              = "main"
  file                = each.value
  content             = file("${local.scaffold_dir}/${each.value}")
  commit_message      = "scaffold: ${each.value} (managed by terraform)"
  overwrite_on_create = true
}
