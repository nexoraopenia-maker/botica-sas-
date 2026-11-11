-- Acción terapéutica del medicamento (ej. Analgésico, Antihipertensivo): se busca por ella en la caja. Solo agrega.
ALTER TABLE products ADD COLUMN therapeutic_action TEXT;
