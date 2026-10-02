# Plataforma de la tienda en Google Cloud (QA): VPC, GKE, Cloud SQL, Memorystore, Pub/Sub y balanceador global.
provider "google" {
  project = "tienda-qa-123456"
  region  = "europe-west1"
}

locals {
  labels = {
    env  = "qa"
    team = "plataforma"
  }
}

resource "google_compute_network" "vpc" {
  name                    = "tienda-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "gke" {
  name                     = "tienda-gke"
  ip_cidr_range            = "10.60.0.0/20"
  region                   = "europe-west1"
  network                  = google_compute_network.vpc.id
  private_ip_google_access = true
}

resource "google_compute_subnetwork" "edge" {
  name          = "tienda-edge-public"
  ip_cidr_range = "10.60.32.0/24"
  region        = "europe-west1"
  network       = google_compute_network.vpc.id
}

resource "google_container_cluster" "main" {
  name               = "tienda-gke"
  location           = "europe-west1"
  network            = google_compute_network.vpc.name
  subnetwork         = google_compute_subnetwork.gke.name
  min_master_version = "1.28"

  resource_labels = local.labels
}

resource "google_container_node_pool" "apps" {
  name       = "apps"
  cluster    = google_container_cluster.main.id
  node_count = 3
}

resource "google_sql_database_instance" "orders" {
  name             = "tienda-orders"
  database_version = "POSTGRES_15"
  region           = "europe-west1"

  settings {
    tier = "db-custom-2-7680"

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.vpc.id
    }

    user_labels = local.labels
  }
}

resource "google_redis_instance" "sessions" {
  name               = "tienda-sessions"
  tier               = "STANDARD_HA"
  memory_size_gb     = 1
  redis_version      = "REDIS_7_0"
  authorized_network = google_compute_network.vpc.id
  labels             = local.labels
}

resource "google_pubsub_topic" "pedidos" {
  name   = "pedidos"
  labels = local.labels
}

resource "google_pubsub_subscription" "pedidos_facturacion" {
  name  = "pedidos-facturacion"
  topic = google_pubsub_topic.pedidos.name
}

resource "google_storage_bucket" "assets" {
  name     = "tienda-qa-assets"
  location = "EU"
  labels   = local.labels
}

resource "google_secret_manager_secret" "db_password" {
  secret_id = "db-password"

  replication {
    auto {}
  }
}

resource "google_artifact_registry_repository" "images" {
  location      = "europe-west1"
  repository_id = "tienda"
  format        = "DOCKER"
}

resource "google_dns_managed_zone" "qa" {
  name     = "qa-tienda"
  dns_name = "qa.tienda.example.com."
}

resource "google_compute_global_forwarding_rule" "https" {
  name       = "tienda-https"
  port_range = "443"
  target     = google_compute_target_https_proxy.main.id
}

resource "google_compute_target_https_proxy" "main" {
  name    = "tienda-https-proxy"
  url_map = "projects/tienda-qa-123456/global/urlMaps/tienda"
}

resource "google_cloud_run_v2_service" "reportes" {
  name     = "reportes"
  location = "europe-west1"

  template {
    containers {
      image = "europe-west1-docker.pkg.dev/tienda-qa-123456/tienda/reportes:2.3.0"
    }
  }
}
