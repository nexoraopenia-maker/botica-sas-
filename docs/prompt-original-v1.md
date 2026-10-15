Actúa como un Principal Software Architect, Tech Lead y experto en normativas de la SUNAT (Perú) y sistemas Cloud SaaS Multi-tenant. 

Requiero que diseñes la arquitectura técnica completa, el esquema de base de datos relacional altamente optimizado (PostgreSQL / Prisma / Supabase) y la lógica core para un **Sistema ERP & Facturación Electrónica Multi-tenant SaaS** especializado en **agroveterinarias, veterinarias y comercios generales**.

Por favor, estructura tu respuesta detallando los siguientes apartados con código de producción limpio y tipado estricto (TypeScript / SQL):

### 1. Arquitectura de Base de Datos Multi-tenant (SQL / Prisma Schema)
- Diseña las tablas relacionales clave con soporte para Multi-tenancy (`tenant_id`), índices optimizados y restricciones de integridad:
  - `tenants` (Datos de la empresa, RUC, Sol User, Sol Pass, Certificado Digital).
  - `branches` (Sucursales / Establecimientos anexos SUNAT).
  - `products` (Control de stock, alertas de vencimiento, lotes, unidades de medida y afectación al IGV - Catálogo SUNAT).
  - `customers` (Tipos de documento: DNI, RUC, Carnet de Extranjería, validación de razón social).
  - `invoices` / `documents` (Cabecera y detalle de comprobantes electrónicos: Facturas, Boletas, Notas de Crédito/Débito, estado SUNAT: `PENDIENTE`, `ACEPTADO`, `RECHAZADO`, CDR, hash y XML).
  - `pets` / `medical_records` (Módulo especializado para veterinarias: paciente, especie, raza, historial clínico, peso, vacunas asociadas al ticket de venta).

### 2. Motor de Facturación Electrónica & Integración SUNAT (UBL 2.1)
- Proporciona un servicio o Server Action en Next.js (TypeScript) que estructure un comprobante electrónico cumpliendo con la normatividad de la SUNAT:
  - Lógica para validar el tope de S/ 700 para DNI obligatorio en boletas de venta.
  - Generación de la estructura del XML (o payload hacia un PSE/OSE) mapeando los códigos de tributos y afectación al IGV.
  - Manejo de respuestas (aceptación de SUNAT, código CDR y errores comunes).

### 3. Transacción Atómica en el Punto de Venta (POS)
- Escribe una función de backend robusta (transacción SQL o Prisma `$transaction`) que ejecute de forma segura una venta en mostrador:
  1. Valide el stock disponible en tiempo real con bloqueo de fila (`FOR UPDATE`).
  2. Descuente el inventario de forma atómica.
  3. Registre la venta y la cabecera/detalle del comprobante fiscal.
  4. Genere el evento de cola para el envío automático del comprobante a la SUNAT.

Demuestra un diseño robusto, escalable, libre de bloqueos de concurrencia y adaptado estrictamente al ecosistema fiscal peruano.