-- MySQL dump 10.13  Distrib 8.0.36, for Linux (x86_64)
--
-- Host: localhost    Database: tienda
-- ------------------------------------------------------
-- Server version	8.0.36

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET NAMES utf8mb4 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;

--
-- Table structure for table `clientes`
--

DROP TABLE IF EXISTS `clientes`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
CREATE TABLE `clientes` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Correo de acceso',
  `nombre` varchar(120) NOT NULL,
  `telefono` varchar(20) DEFAULT NULL,
  `estado` enum('activo','baja','bloqueado') NOT NULL DEFAULT 'activo',
  `creado_en` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `actualizado_en` datetime DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_clientes_email` (`email`),
  KEY `idx_clientes_estado` (`estado`)
) ENGINE=InnoDB AUTO_INCREMENT=1042 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Personas que compran en la tienda';
/*!40101 SET character_set_client = @saved_cs_client */;

DROP TABLE IF EXISTS `productos`;
CREATE TABLE `productos` (
  `id` int NOT NULL AUTO_INCREMENT,
  `sku` varchar(32) NOT NULL,
  `nombre` varchar(200) NOT NULL,
  `precio` decimal(12,2) NOT NULL,
  `stock` smallint unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `sku` (`sku`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS `pedidos`;
CREATE TABLE `pedidos` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `cliente_id` int unsigned NOT NULL,
  `estado` varchar(20) NOT NULL DEFAULT 'nuevo',
  `total` decimal(12,2) NOT NULL,
  `creado_en` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_pedidos_cliente` (`cliente_id`),
  CONSTRAINT `fk_pedidos_cliente` FOREIGN KEY (`cliente_id`) REFERENCES `clientes` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Un pedido por compra';

DROP TABLE IF EXISTS `pedido_lineas`;
CREATE TABLE `pedido_lineas` (
  `pedido_id` bigint NOT NULL,
  `linea` int NOT NULL,
  `producto_id` int NOT NULL,
  `cantidad` int NOT NULL,
  `precio_unitario` decimal(12,2) NOT NULL,
  PRIMARY KEY (`pedido_id`,`linea`),
  KEY `fk_lineas_producto` (`producto_id`),
  CONSTRAINT `fk_lineas_pedido` FOREIGN KEY (`pedido_id`) REFERENCES `pedidos` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_lineas_producto` FOREIGN KEY (`producto_id`) REFERENCES `productos` (`id`),
  CONSTRAINT `chk_cantidad` CHECK ((`cantidad` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Final view structure for view `ventas_por_cliente`
--

/*!50001 DROP VIEW IF EXISTS `ventas_por_cliente`*/;
/*!50001 CREATE ALGORITHM=UNDEFINED */
/*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */
/*!50001 VIEW `ventas_por_cliente` AS select `c`.`id` AS `cliente_id`,`c`.`nombre` AS `nombre`,count(`p`.`id`) AS `pedidos`,sum(`p`.`total`) AS `total` from (`clientes` `c` left join `pedidos` `p` on((`p`.`cliente_id` = `c`.`id`))) group by `c`.`id`,`c`.`nombre` */;

CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `productos_activos` AS
  SELECT id, sku, nombre, precio FROM productos WHERE stock > 0;

DELIMITER ;;
CREATE TRIGGER `pedidos_bi` BEFORE INSERT ON `pedidos` FOR EACH ROW
BEGIN
  IF NEW.total < 0 THEN
    SET NEW.total = 0;
  END IF;
  INSERT INTO auditoria (tabla) VALUES ('pedidos');
END ;;
DELIMITER ;

/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
