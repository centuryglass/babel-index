variable "cloudflare_api_token" {
  description = "Scoped Cloudflare API token: R2 edit on the target account, plus Zone WAF/Cache Rules edit on cloudflare_zone_id if enable_zone_protections is used. Never commit this - set it in terraform.tfvars, which is gitignored."
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the R2 bucket."
  type        = string
}

variable "r2_bucket_name" {
  description = "R2 bucket name. Must match whatever tools/upload/upload-r2.mjs is pointed at (R2_BUCKET / --bucket)."
  type        = string
  default     = "babel-index-corpus"
}

variable "r2_location" {
  description = "Optional R2 location hint (e.g. \"WNAM\", \"ENAM\", \"WEUR\", \"EEUR\", \"APAC\"). Leave null to let Cloudflare choose."
  type        = string
  default     = null
}

# --- Zone-level abuse protection ---
#
# These resources sit in front of the bucket on a custom domain, not the
# default *.r2.dev url, because Cache Rules and WAF rate limiting are zone
# features. They're all gated behind enable_zone_protections because they
# can't do anything useful until that domain's zone exists and is bound to
# the bucket - and because a `cloudflare_ruleset` apply takes full ownership
# of its (zone, phase) pair, which can silently wipe out rules already set
# up by hand in the dashboard. See infra/README.md before flipping this on.

variable "enable_zone_protections" {
  description = "Manage the custom domain binding, WAF rate limit, cache rule, and billing alert. Leave false for the initial bucket-only apply."
  type        = bool
  default     = false
}

variable "cloudflare_zone_id" {
  description = "Zone ID for the domain fronting the bucket. Required when enable_zone_protections is true."
  type        = string
  default     = null
}

variable "assets_hostname" {
  description = "Hostname the bucket is bound to as an R2 custom domain (e.g. assets.example.com). Required when enable_zone_protections is true."
  type        = string
  default     = null
}

variable "rate_limit_requests_per_period" {
  description = "Requests per IP per rate_limit_period_seconds before the WAF rule starts blocking."
  type        = number
  default     = 50
}

# The Free plan is only entitled to a 10-second counting period (a
# terraform apply with 60 fails with "not entitled to use the period 60,
# can only use a period among [10]") - a paid plan may allow others.
variable "rate_limit_period_seconds" {
  type    = number
  default = 10
}

variable "rate_limit_mitigation_timeout_seconds" {
  description = "How long a blocked IP stays blocked once it trips the rate limit. The Free plan is only entitled to 10 (same apply-time error pattern as rate_limit_period_seconds above) - a paid plan may allow others."
  type        = number
  default     = 10
}

variable "cache_edge_ttl_seconds" {
  description = "How long Cloudflare's edge caches a corpus asset before treating a repeat GET as a fresh R2 Class B operation. Uploaded filenames are content-addressed by tools/upload's manifest (a changed file gets uploaded under the same key, but the corpus is otherwise static), so a long TTL is safe; purge manually after a re-upload if you need the edge to pick it up sooner."
  type        = number
  default     = 86400
}

variable "billing_alert_email_integration_id" {
  description = "ID of an existing Cloudflare account email notification integration (create it in the dashboard first - Terraform can't). Leave null to skip the billing alert resource entirely."
  type        = string
  default     = null
}

variable "billing_alert_limit_usd" {
  description = "Dollar threshold that triggers the R2 billing_usage_alert notification policy."
  type        = number
  default     = 5
}

# --- CORS ---
#
# Bucket-level, so this applies regardless of enable_zone_protections and
# works even against the bare *.r2.dev url - unlike the WAF/cache rules above,
# it needs no zone. It exists because packages/server/remote.ts points the
# --remote-mode manifest's urls straight at this bucket, and two of them
# (embeddings.bin, metadata.json) are read with `fetch()` in
# packages/web/src/main.jsx rather than an <img> tag - fetch() enforces CORS
# cross-origin, an <img> tag does not, so the room tiles work with no CORS
# rule at all but those two requests fail silently without one.

variable "app_origins" {
  description = "Origins allowed to fetch embeddings.bin/metadata.json cross-origin from the R2 bucket (e.g. [\"https://babel.example.com\", \"http://localhost:5173\"] for prod plus local --remote testing). Leave empty to skip the CORS resource entirely - harmless until the demo server actually runs in --remote mode against this bucket."
  type        = list(string)
  default     = []
}
