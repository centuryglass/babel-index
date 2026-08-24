# infra — Cloudflare R2, applied locally

Terraform for the R2 bucket `tools/upload/upload-r2.mjs` syncs the corpus
into, plus the abuse protection in front of it. There is deliberately no
CI/CD wiring here: this is applied by hand, from your own machine, with
credentials that never touch a GitHub Actions runner or secret store.

## Why the abuse protection exists

R2 has no egress fee, so a request flood isn't a bandwidth bill - it's an
*operation-count* one: Class A ops (writes/lists/deletes) run $4.50/million,
Class B ops (reads) run $0.36/million, both with free monthly allowances.
Unmitigated, a large enough flood of GETs directly against the bucket is a
real bill, not just a slowdown. The defenses here, cheapest first:

1. **Edge caching** (`cloudflare_ruleset.cache_assets`) - the single biggest
   lever. A cached GET is served by Cloudflare and never becomes a billed R2
   Class B operation at all.
2. **WAF rate limiting** (`cloudflare_ruleset.rate_limit_assets`) - throttles
   an IP that's hammering the corpus hostname before it reaches R2.
3. **A billing alert** (`cloudflare_notification_policy.r2_spend_alert`,
   optional) - not a kill switch (R2 has none), but tells you something is
   wrong before the invoice does.

All three are free on Cloudflare's Free plan at this scale; nothing here
needs a paid plan.

## Setup

```sh
cd infra
cp terraform.tfvars.example terraform.tfvars   # gitignored - fill in real values
terraform init
terraform plan
terraform apply
```

### First apply: bucket only

Leave `enable_zone_protections = false` (the default) for the first apply.
It only needs `cloudflare_api_token` and `cloudflare_account_id` and creates
just the R2 bucket - enough to point `tools/upload/upload-r2.mjs` at
(`R2_BUCKET` = the `r2_bucket_name` you set, `R2_ACCOUNT_ID` = the same
account id) and test a real upload before anything else is in front of it.

### Second apply: zone protections

Once you have a domain (zone) you're willing to front the bucket with:

1. Fill in `cloudflare_zone_id`, `assets_hostname`, and set
   `enable_zone_protections = true` in `terraform.tfvars`.
2. **Before running `terraform apply`**, check that zone's dashboard for any
   rate-limit or cache rules already configured by hand. `cloudflare_ruleset`
   takes full ownership of its `(zone, phase)` pair - `http_ratelimit` for
   the rate limit, `http_request_cache_settings` for the cache rule - and an
   apply can silently replace whatever's already there. Either import
   existing rulesets first with [`cf-terraforming`](https://github.com/cloudflare/cf-terraforming),
   or use a zone that has nothing configured yet.
3. `terraform plan` and review the diff, then `apply`.

This binds the bucket to `assets_hostname` as an R2 custom domain (the
default `*.r2.dev` url isn't a zone Terraform can attach WAF/cache rules to),
adds the rate limit and cache ruleset, and - if you set
`billing_alert_email_integration_id` - the spend alert. That variable points
at an existing Cloudflare account *email integration*; create it in the
dashboard first, Terraform doesn't manage it here.

## Things to verify before relying on this

Carried over from the abuse-protection review that prompted this stack -
check these against current Cloudflare/provider docs before trusting the
apply, since they're exactly the kind of detail that drifts between provider
versions:

- `cloudflare_notification_policy`'s `alert_type = "billing_usage_alert"` in
  `abuse-protection.tf` - confirm this is still the right string. A wrong one
  fails `plan`, not `apply`, so this is more "double check" than "hope."
- Bot Fight Mode isn't a standalone resource in this stack. It's a zone
  setting (`cloudflare_zone_settings_override`, or `bot_management` on
  Business+) - worth adding once `assets_hostname` is live, if scraper
  traffic shaped like Bot Fight Mode targets shows up.
- `assets_hostname` is currently the only path-scoping the rate limit and
  cache rules use (`http.host eq ...`). If the bucket ever serves more than
  the corpus under that hostname, narrow the `expression` in
  `abuse-protection.tf` to a path pattern too.
- Nothing here puts a Worker in front of R2 to check auth/referrer/signed
  URLs before proxying - the bucket is public read once
  `enable_zone_protections` binds it to a hostname. Add that layer if the
  corpus needs to not be fully public.

## State

Local state (`terraform.tfstate*`) is gitignored - see `infra/.gitignore`.
Since this is applied from one machine by hand, that's the source of truth;
back it up yourself (or move to a remote backend) if that machine isn't
durable. `.terraform.lock.hcl`, once `terraform init` generates it, should be
committed so everyone applying this gets the same provider version.
