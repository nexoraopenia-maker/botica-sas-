# Cumplimiento normativo — qué implementa el sistema y qué validar

> Este documento describe decisiones técnicas. **No es asesoría legal.** Los puntos marcados ⚠️ deben confirmarse con el contador del cliente (SUNAT) o con un asesor regulatorio (DIGEMID / SENASA) antes de salir a producción.

## SUNAT — comprobantes electrónicos

| Regla | Implementación |
|---|---|
| UBL 2.1, CustomizationID 2.0 | `src/lib/sunat/ubl.ts` (Factura/Boleta `Invoice`, `CreditNote`, `DebitNote`) |
| Firma XMLDSig enveloped en `ext:ExtensionContent` | `src/lib/sunat/signer.ts` (RSA-SHA1 por compatibilidad; SHA-256 disponible) ⚠️ confirmar algoritmo aceptado por el OSE elegido |
| Nombre de archivo `RUC-TT-SERIE-NUMERO.zip` | `sunatFileName()` |
| Boleta > S/ 700 exige identificar al adquirente | `validateDocumentRules()` + `CHECK documents_boleta_700_chk` |
| Factura exige RUC del adquirente | idem + `CHECK documents_factura_ruc_chk` |
| Serie F### / B###; NC/ND con la letra del comprobante afectado | validación + `CHECK document_series_format_chk` |
| Forma de pago (Contado / Crédito con cuota) en facturas | `paymentTerms()` en el builder |
| Leyenda 1000 (monto en letras), 1002 (gratuitas) | `amount-in-words.ts` |
| ICBPER (bolsas) S/ 0.50 por unidad | `computeLine()` ⚠️ confirmar tasa vigente |
| Plazo de envío (3 días calendario) | `MAX_SEND_DELAY_DAYS` ⚠️ confirmar plazo vigente por tipo de comprobante |
| Clasificación de respuestas (0 / 0100–1999 / 2000–3999 / 4000+) | `src/lib/sunat/errors.ts` |
| 1033 "registrado previamente" | se consulta `getStatusCdr` en lugar de reenviar |
| QR de la representación impresa | `src/lib/sunat/qr.ts` (el hash se completa cuando el worker firma) |
| Retención de comprobantes | los documentos nunca se borran (trigger); la purga de tenant los conserva ⚠️ plazo de conservación según prescripción tributaria (Código Tributario) — confirmar con contador |

**Boletas:** se envían individualmente con `sendBill`. ⚠️ Algunos OSE exigen o prefieren el Resumen Diario: confirmar con el proveedor.

**Anulaciones:** el flujo implementado es la **Nota de Crédito motivo 01** (con reposición de stock al lote original). El XML de **Comunicación de Baja** (`buildVoidedDocumentsXml`) está construido pero el envío asíncrono (`sendSummary` + `getStatus` por ticket) aún no está cableado al worker.

## DIGEMID — boticas y farmacias ⚠️

Normas que el asesor regulatorio debe revisar contra la implementación:

- **Ley 29459** (productos farmacéuticos) y **DS 014-2011-SA** (Reglamento de Establecimientos Farmacéuticos): condición de venta, dispensación por químico farmacéutico, director técnico.
  → `products.sale_condition`, `pharmacist_staff` (colegiatura CQFP, DT), dispensación con receta solo con permiso `pharmacy.dispense_rx` y QF registrado en la sucursal.
- **DS 023-2001-SA** (estupefacientes y psicotrópicos): receta especial, libros de control.
  → `controlled_substance_log` con saldo automático por trigger, nunca negativo, append-only; receta `SPECIAL` retenida y de un solo uso.
  ⚠️ Vigencias de receta: `DEFAULT_RX_POLICY` (3 días especial / 30 días común) son **parámetros provisionales**.
  ⚠️ Formato oficial del libro y periodicidad de informes a DIGEMID.
- **Observatorio Peruano de Productos Farmacéuticos** (reporte de precios y stock): el modelo ya guarda `digemid_product_code`, `digemid_registration`, precio y stock por sucursal. ⚠️ Confirmar norma vigente, frecuencia y formato de envío; el exportador no está implementado.
- **Disponibilidad de genéricos en DCI**: la búsqueda devuelve alternativas genéricas (mismo DCI + concentración + forma) con stock. ⚠️ Confirmar obligaciones vigentes de oferta mínima de genéricos.
- **Buenas Prácticas de Almacenamiento**: FEFO, cuarentena de lotes (`is_quarantined`), bloqueo de vencidos y alertas de caducidad.

## SENASA — productos veterinarios ⚠️

- Registro SENASA por producto (`products.senasa_registration`).
- Periodos de retiro carne/leche (`withdrawal_days_meat/milk`): el POS devuelve advertencias para informar al productor. ⚠️ Confirmar si debe imprimirse en el comprobante o en un documento aparte.
- Catálogo de vacunas global (`prisma/seed.sql`) es **referencial**: cada clínica debe validar esquemas con su médico veterinario; las campañas oficiales (aftosa, peste porcina) siguen el calendario de SENASA.

## Datos personales (Ley 29733)

- Datos de propietarios, pacientes y recetas aislados por tenant (RLS).
- La purga de tenant anonimiza propietarios, mascotas, historias clínicas y clientes; conserva lo fiscal.
- WhatsApp: `owners.notify_whatsapp` / `customers.whatsapp_opt_in` como consentimiento. ⚠️ Confirmar texto de consentimiento y registro del banco de datos ante la ANPD.
