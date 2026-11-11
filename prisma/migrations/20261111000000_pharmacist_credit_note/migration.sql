-- El químico farmacéutico emite las notas de crédito de medicamentos controlados: los roles se copian a cada negocio al crearlo,
-- así que los farmacéuticos existentes no reciben el permiso desde SYSTEM_ROLES. Solo agrega un permiso; no toca ventas ni stock.
UPDATE roles SET permissions = array_append(permissions, 'documents.credit_note'), updated_at = now()
 WHERE key = 'pharmacist' AND is_system AND deleted_at IS NULL
   AND NOT permissions @> ARRAY['documents.credit_note'] AND NOT permissions @> ARRAY['*'];
