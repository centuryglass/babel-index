# R2 has no egress fee, so a request flood isn't a bandwidth bill - it's an
# operation-count one (Class A writes/lists/deletes, Class B reads). These
# two rulesets exist to keep both a scraper and a genuine traffic spike from
# turning into a surprise invoice: cache_assets stops a repeat GET from ever
# reaching R2 as a billed Class B op, and rate_limit_assets stops a flood
# from reaching the origin at all. See infra/README.md for the cost math.
#
# Both are zone-level `cloudflare_ruleset` resources scoped to one (zone,
# phase) pair each. A `terraform apply` takes full ownership of that pair -
# if this zone already has rate-limit or cache rules set up by hand in the
# dashboard, applying this blind can silently replace them. Import first
# with cf-terraforming, or start from a zone with nothing configured yet.

resource "cloudflare_ruleset" "rate_limit_assets" {
  count       = var.enable_zone_protections ? 1 : 0
  zone_id     = var.cloudflare_zone_id
  name        = "R2 asset rate limiting"
  description = "Throttle abusive clients before they run up R2 Class B operation charges"
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = [{
    ref         = "rl_assets_by_ip"
    description = "Rate limit corpus asset requests by IP"
    expression  = "(http.host eq \"${var.assets_hostname}\")"
    action      = "block"
    ratelimit = {
      characteristics     = ["cf.colo.id", "ip.src"]
      period              = var.rate_limit_period_seconds
      requests_per_period = var.rate_limit_requests_per_period
      mitigation_timeout  = var.rate_limit_mitigation_timeout_seconds
      counting_expression = "(http.host eq \"${var.assets_hostname}\" and not cf.cache_status in {\"HIT\" \"REVALIDATED\"})"
    }
  }]
}

resource "cloudflare_ruleset" "cache_assets" {
  count       = var.enable_zone_protections ? 1 : 0
  zone_id     = var.cloudflare_zone_id
  name        = "Cache R2 corpus assets"
  description = "Serve repeat GETs from the edge instead of billing them as R2 Class B operations"
  kind        = "zone"
  phase       = "http_request_cache_settings"

  rules = [{
    ref         = "cache_assets_hostname"
    description = "Cache everything served from the corpus hostname"
    expression  = "(http.host eq \"${var.assets_hostname}\")"
    action      = "set_cache_settings"
    action_parameters = {
      cache = true
      edge_ttl = {
        mode    = "override_origin"
        default = var.cache_edge_ttl_seconds
      }
    }
  }]
}

# `alert_type` has shifted between provider versions before - confirm
# "billing_usage_alert" is still current against the cloudflare/cloudflare
# docs for the pinned version in versions.tf before applying. If it's wrong,
# `terraform plan` will fail loudly rather than apply something silently
# different.
#
# `filters.product` has no documented list of valid values, and the API
# rejects guesses ("R2", "R2 Storage") with error 17106 "Invalid product
# selection" - Cloudflare community reports suggest the products list is
# only populated for accounts already metered on that product. Left disabled
# (billing_alert_email_integration_id unset in terraform.tfvars) in favor of
# a manually-configured account-wide alert. Find the real product string
# before turning this back on - check the dashboard's notification-creation
# form's network request, or retry once R2 usage is nonzero.
resource "cloudflare_notification_policy" "r2_spend_alert" {
  count       = var.billing_alert_email_integration_id != null ? 1 : 0
  account_id  = var.cloudflare_account_id
  name        = "R2 spend alert"
  description = "Alert when R2 usage crosses a billing threshold"
  enabled     = true
  alert_type  = "billing_usage_alert"

  filters = {
    product = ["R2 Storage"]
    limit   = [tostring(var.billing_alert_limit_usd)]
  }

  mechanisms = {
    email = [{
      id = var.billing_alert_email_integration_id
    }]
  }
}
