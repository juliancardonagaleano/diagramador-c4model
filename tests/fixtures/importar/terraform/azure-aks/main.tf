# Plataforma de la tienda en Azure: red virtual, AKS, PostgreSQL flexible, Redis, Service Bus y Application Gateway.
terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.90"
    }
  }

  cloud {
    organization = "acme"

    workspaces {
      name = "tienda-pre"
    }
  }
}

provider "azurerm" {
  features {}
}

variable "location" {
  default = "westeurope"
}

resource "azurerm_resource_group" "main" {
  name     = "rg-tienda-pre"
  location = var.location
}

resource "azurerm_virtual_network" "main" {
  name                = "vnet-tienda-pre"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  address_space       = ["10.50.0.0/16"]
}

resource "azurerm_subnet" "aks" {
  name                 = "snet-aks"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.50.0.0/22"]
}

resource "azurerm_subnet" "data" {
  name                 = "snet-data"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.50.8.0/24"]

  delegation {
    name = "postgres"

    service_delegation {
      name = "Microsoft.DBforPostgreSQL/flexibleServers"
    }
  }
}

resource "azurerm_subnet" "gateway" {
  name                 = "snet-public-gateway"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.50.9.0/24"]
}

resource "azurerm_container_registry" "main" {
  name                = "acrtiendapre"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "Standard"
}

resource "azurerm_kubernetes_cluster" "main" {
  name                = "aks-tienda-pre"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  dns_prefix          = "tienda-pre"
  kubernetes_version  = "1.28.5"

  default_node_pool {
    name           = "system"
    node_count     = 3
    vm_size        = "Standard_D4s_v5"
    vnet_subnet_id = azurerm_subnet.aks.id
  }

  identity {
    type = "SystemAssigned"
  }
}

resource "azurerm_role_assignment" "aks_acr" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_kubernetes_cluster.main.kubelet_identity[0].object_id
}

resource "azurerm_postgresql_flexible_server" "main" {
  name                   = "psql-tienda-pre"
  resource_group_name    = azurerm_resource_group.main.name
  location               = azurerm_resource_group.main.location
  version                = "15"
  delegated_subnet_id    = azurerm_subnet.data.id
  administrator_login    = "tienda"
  administrator_password = "cambiar-en-el-pipeline"
  sku_name               = "GP_Standard_D2s_v3"
}

resource "azurerm_redis_cache" "main" {
  name                = "redis-tienda-pre"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  capacity            = 1
  family              = "C"
  sku_name            = "Standard"
}

resource "azurerm_servicebus_namespace" "main" {
  name                = "sb-tienda-pre"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "Standard"
}

resource "azurerm_servicebus_queue" "pedidos" {
  name         = "pedidos"
  namespace_id = azurerm_servicebus_namespace.main.id
}

resource "azurerm_storage_account" "main" {
  name                     = "sttiendapre"
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "GRS"
}

resource "azurerm_key_vault" "main" {
  name                = "kv-tienda-pre"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tenant_id           = "00000000-0000-0000-0000-000000000000"
  sku_name            = "standard"
}

resource "azurerm_public_ip" "gateway" {
  name                = "pip-tienda-pre"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_application_gateway" "main" {
  name                = "agw-tienda-pre"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  sku {
    name     = "WAF_v2"
    tier     = "WAF_v2"
    capacity = 2
  }

  gateway_ip_configuration {
    name      = "gateway-ip"
    subnet_id = azurerm_subnet.gateway.id
  }

  frontend_ip_configuration {
    name                 = "public"
    public_ip_address_id = azurerm_public_ip.gateway.id
  }
}

resource "azurerm_dns_zone" "main" {
  name                = "pre.tienda.example.com"
  resource_group_name = azurerm_resource_group.main.name
}

resource "azurerm_log_analytics_workspace" "main" {
  name                = "log-tienda-pre"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  retention_in_days   = 30
}

resource "azurerm_firewall" "egress" {
  name                = "fw-tienda-pre"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku_name            = "AZFW_VNet"
  sku_tier            = "Standard"
}
