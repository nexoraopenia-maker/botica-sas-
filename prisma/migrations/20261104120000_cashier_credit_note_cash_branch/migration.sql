-- El cajero emite notas de crédito, y la devolución descuenta la caja de quien la entrega, que puede no ser la sucursal de la venta.
ALTER TABLE document_payments ADD COLUMN cash_branch_id UUID;
ALTER TABLE document_payments
  ADD CONSTRAINT document_payments_cash_branch_tenant_fk FOREIGN KEY (tenant_id, cash_branch_id) REFERENCES branches(tenant_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Los roles se copian a cada negocio al crearlo: los cajeros existentes no reciben el permiso desde SYSTEM_ROLES
UPDATE roles SET permissions = array_append(permissions, 'documents.credit_note'), updated_at = now()
 WHERE key = 'cashier' AND is_system AND deleted_at IS NULL
   AND NOT permissions @> ARRAY['documents.credit_note'] AND NOT permissions @> ARRAY['*'];
