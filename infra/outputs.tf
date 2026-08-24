output "r2_bucket_name" {
  description = "Pass this as --bucket / R2_BUCKET to tools/upload/upload-r2.mjs."
  value       = cloudflare_r2_bucket.corpus.name
}

output "assets_hostname" {
  description = "Hostname the bucket is bound to, once enable_zone_protections is true. This is what a future R2-backed demo server would read the corpus from."
  value       = var.enable_zone_protections ? var.assets_hostname : null
}
