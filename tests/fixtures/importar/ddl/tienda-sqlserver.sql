USE [Tienda]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE SCHEMA [ventas]
GO
CREATE TABLE [ventas].[Clientes](
	[ClienteId] [int] IDENTITY(1,1) NOT NULL,
	[Email] [nvarchar](255) NOT NULL,
	[Nombre] [nvarchar](120) NOT NULL,
	[Telefono] [varchar](20) NULL,
	[Notas] [nvarchar](max) NULL,
	[CreadoEn] [datetime2](7) NOT NULL,
	[Saldo] [decimal](12, 2) NOT NULL,
	[SaldoConIva]  AS ([Saldo]*(1.21)),
 CONSTRAINT [PK_Clientes] PRIMARY KEY CLUSTERED
(
	[ClienteId] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY],
 CONSTRAINT [UQ_Clientes_Email] UNIQUE NONCLUSTERED
(
	[Email] ASC
)WITH (PAD_INDEX = OFF) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
CREATE TABLE [ventas].[Pedidos](
	[PedidoId] [bigint] IDENTITY(1,1) NOT NULL,
	[ClienteId] [int] NOT NULL,
	[Estado] [varchar](20) NOT NULL,
	[Total] [decimal](12, 2) NOT NULL,
	[CreadoEn] [datetime2](7) NOT NULL,
PRIMARY KEY CLUSTERED
(
	[PedidoId] ASC
)WITH (PAD_INDEX = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
CREATE TABLE [ventas].[Productos](
	[ProductoId] [int] IDENTITY(1,1) NOT NULL,
	[Sku] [varchar](32) NOT NULL,
	[Nombre] [nvarchar](200) NOT NULL,
	[Precio] [money] NOT NULL,
	CONSTRAINT [PK_Productos] PRIMARY KEY CLUSTERED ([ProductoId] ASC)
)
GO
CREATE TABLE [ventas].[PedidoLineas](
	[PedidoId] [bigint] NOT NULL,
	[Linea] [int] NOT NULL,
	[ProductoId] [int] NOT NULL,
	[Cantidad] [int] NOT NULL,
	CONSTRAINT [PK_PedidoLineas] PRIMARY KEY CLUSTERED ([PedidoId] ASC, [Linea] ASC)
)
GO
ALTER TABLE [ventas].[Clientes] ADD  DEFAULT (getdate()) FOR [CreadoEn]
GO
ALTER TABLE [ventas].[Pedidos]  WITH CHECK ADD  CONSTRAINT [FK_Pedidos_Clientes] FOREIGN KEY([ClienteId])
REFERENCES [ventas].[Clientes] ([ClienteId])
GO
ALTER TABLE [ventas].[Pedidos] CHECK CONSTRAINT [FK_Pedidos_Clientes]
GO
ALTER TABLE [ventas].[PedidoLineas]  WITH CHECK ADD  CONSTRAINT [FK_Lineas_Pedidos] FOREIGN KEY([PedidoId])
REFERENCES [ventas].[Pedidos] ([PedidoId])
ON DELETE CASCADE
GO
ALTER TABLE [ventas].[PedidoLineas]  WITH NOCHECK ADD  CONSTRAINT [FK_Lineas_Productos] FOREIGN KEY([ProductoId])
REFERENCES [ventas].[Productos] ([ProductoId])
GO
CREATE VIEW [ventas].[VentasPorCliente]
WITH SCHEMABINDING
AS
SELECT c.ClienteId, c.Nombre, COUNT_BIG(*) AS Pedidos, SUM(p.Total) AS Total
FROM [ventas].[Clientes] AS c
INNER JOIN [ventas].[Pedidos] AS p ON p.ClienteId = c.ClienteId
GROUP BY c.ClienteId, c.Nombre
GO
EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'Personas que compran' , @level0type=N'SCHEMA',@level0name=N'ventas', @level1type=N'TABLE',@level1name=N'Clientes'
GO
CREATE NONCLUSTERED INDEX [IX_Pedidos_Cliente] ON [ventas].[Pedidos] ([ClienteId] ASC)
GO
