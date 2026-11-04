-- API key de Claude de cada persona del estudio (BYOK): el asistente del panel consulta
-- al modelo con la key de quien pregunta, no con una del estudio.
--
-- La key va cifrada (AES-256-GCM, CREDENTIALS_KEY) en `clave_cifrada` con el user_id como
-- dato autenticado: copiar la fila a otra persona no sirve. Nunca se guarda ni se devuelve
-- en claro; al navegador solo llegan los últimos 4 caracteres.
CREATE TABLE IF NOT EXISTS claves_ia (
  user_id        uuid        PRIMARY KEY,
  clave_cifrada  text        NOT NULL,
  ultimos4       text        NOT NULL,
  -- 'invalida' = Anthropic la rechazó (revocada, sin permisos): hay que reemplazarla.
  estado         text        NOT NULL DEFAULT 'activa' CHECK (estado IN ('activa', 'invalida')),
  creado         timestamptz NOT NULL DEFAULT now(),
  actualizado    timestamptz NOT NULL DEFAULT now()
);

-- Misma idea que equipo: con Supabase la fila se borra junto con la cuenta.
DO $$
BEGIN
  IF to_regclass('auth.users') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claves_ia_user_id_fkey' AND conrelid = 'claves_ia'::regclass) THEN
    ALTER TABLE claves_ia ADD CONSTRAINT claves_ia_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE;
  END IF;
END $$;

-- RLS: el navegador nunca habla con esta tabla (solo el servidor, con el rol de la app).
-- Sin políticas para anon/authenticated nadie la lee por la API pública aunque tenga un JWT.
-- El acceso "cada persona solo ve su fila" lo impone el servidor: toda consulta filtra por
-- el user_id de la sesión validada, nunca por uno que mande el cliente.
ALTER TABLE claves_ia ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agente_contable_app') THEN
    DROP POLICY IF EXISTS app_total ON claves_ia;
    CREATE POLICY app_total ON claves_ia FOR ALL TO agente_contable_app USING (true) WITH CHECK (true);
    GRANT SELECT, INSERT, UPDATE, DELETE ON claves_ia TO agente_contable_app;
  END IF;
END $$;
