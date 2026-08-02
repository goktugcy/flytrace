// Build every FlyTrace image with one command.
//
//   docker buildx bake -f deploy/docker-bake.hcl                 # all
//   docker buildx bake -f deploy/docker-bake.hcl services        # bun services
//   docker buildx bake -f deploy/docker-bake.hcl api             # one image
//
// The four Bun services differ only by the APP build arg, so they share a
// single target definition via `matrix` — a service cannot accidentally end up
// on a different base image or hardening posture from its siblings.

variable "TAG"    { default = "ci" }
variable "PREFIX" { default = "flytrace" }
variable "GIT_SHA" { default = "unknown" }

// Public, non-secret defaults for the web client bundle. Override per
// environment; never put a secret here — NEXT_PUBLIC_* is inlined into
// JavaScript the browser downloads.
variable "NEXT_PUBLIC_API_URL" { default = "https://api.ci.invalid" }
variable "NEXT_PUBLIC_WS_URL"  { default = "wss://api.ci.invalid/ws" }

group "default" {
  targets = ["services", "web", "migrate"]
}

group "services" {
  targets = ["service"]
}

target "service" {
  name       = item.app
  matrix     = { item = [{ app = "api" }, { app = "tracker" }, { app = "worker" }, { app = "notifier" }] }
  context    = "."
  dockerfile = "deploy/Dockerfile.bun"
  args = {
    APP         = item.app
    APP_VERSION = TAG
    GIT_SHA     = GIT_SHA
  }
  tags = ["${PREFIX}/${item.app}:${TAG}"]
}

target "migrate" {
  context    = "."
  dockerfile = "deploy/Dockerfile.migrate"
  tags       = ["${PREFIX}/migrate:${TAG}"]
}

target "web" {
  context    = "."
  dockerfile = "deploy/Dockerfile.web"
  args = {
    NEXT_PUBLIC_API_URL = NEXT_PUBLIC_API_URL
    NEXT_PUBLIC_WS_URL  = NEXT_PUBLIC_WS_URL
    APP_VERSION         = TAG
    GIT_SHA             = GIT_SHA
  }
  tags = ["${PREFIX}/web:${TAG}"]
}
