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

  rules {
    ref         = "rl_assets_by_ip"
    description = "Rate limit corpus asset requests by IP"
    expression  = "(http.host eq \"${var.assets_hostname}\")"
    action      = "block"
    ratelimit {
      characteristics     = ["cf.colo.id", "ip.src"]
      period              = var.rate_limit_period_seconds
      requests_per_period = var.rate_limit_requests_per_period
      mitigation_timeout  = var.rate_limit_mitigation_timeout_seconds
    }
  }
}

resource "cloudflare_ruleset" "cache_assets" {
  count       = var.enable_zone_protections ? 1 : 0
  zone_id     = var.cloudflare_zone_id
  name        = "Cache R2 corpus assets"
  description = "Serve repeat GETs from the edge instead of billing them as R2 Class B operations"
  kind        = "zone"
  phase       = "http_request_cache_settings"

  rules {
    ref         = "cache_assets_hostname"
    description = "Cache everything served from the corpus hostname"
    expression  = "(http.host eq \"${var.assets_hostname}\")"
    action      = "set_cache_settings"
    action_parameters {
      cache = true
      edge_ttl {
        mode    = "override_origin"
        default = var.cache_edge_ttl_seconds
      }
    }
  }
}

# TODO(verify before enabling): `alert_type` has shifted between provider
# versions - confirm "billing_usage_alert" is still current against the
# cloudflare/cloudflare docs for the pinned version in versions.tf before
# applying. If it's wrong, `terraform plan` will fail loudly rather than
# apply something silently different.
resource "cloudflare_notification_policy" "r2_spend_alert" {
  count       = var.billing_alert_email_integration_id != null ? 1 : 0
  account_id  = var.cloudflare_account_id
  name        = "R2 spend alert"
  description = "Alert when R2 usage crosses a billing threshold"
  enabled     = true
  alert_type  = "billing_usage_alert"

  email_integration {
    id = var.billing_alert_email_integration_id
  }
}
