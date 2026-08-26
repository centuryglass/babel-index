# The bucket tools/upload/upload-r2.mjs syncs the corpus into.
resource "cloudflare_r2_bucket" "corpus" {
  account_id = var.cloudflare_account_id
  name       = var.r2_bucket_name
  location   = var.r2_location
}

# Binds the bucket to a real hostname on a zone, which is what makes the WAF
# rate limit and cache rules below possible - the default *.r2.dev url isn't
# a zone Cloudflare will let you attach zone-level rules to.
resource "cloudflare_r2_custom_domain" "corpus" {
  count       = var.enable_zone_protections ? 1 : 0
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.corpus.name
  zone_id     = var.cloudflare_zone_id
  domain      = var.assets_hostname
  enabled     = true
}

# See variables.tf's app_origins for why this exists. Does not support
# `terraform import` (confirmed against the provider's own docs at the
# version pinned in versions.tf) - if this bucket ever grows a CORS rule set
# by hand instead, it has to be recreated here rather than imported.
resource "cloudflare_r2_bucket_cors" "corpus" {
  count       = length(var.app_origins) > 0 ? 1 : 0
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.corpus.name

  rules = [{
    id = "allow-app-fetch"
    allowed = {
      methods = ["GET"]
      origins = var.app_origins
    }
    max_age_seconds = 86400
  }]
}
