-- La API key de Claude pasa de ser "una por persona" (0005) a UNA del estudio que configura
-- un administrador. La tabla por persona se reemplaza por una de una sola fila.
--
-- Se aborta si claves_ia ya tiene datos: no se borra una key guardada sin que alguien lo decida.
DO $$
BEGIN
  IF to_regclass('claves_ia') IS NOT NULL AND EXISTS (SELECT 1 FROM claves_ia) THEN
    RAISE EXCEPTION 'claves_ia tiene filas: revísalas antes de eliminar la tabla';
  END IF;
END $$;

DROP TABLE IF EXISTS claves_ia;

-- La key va cifrada (AES-256-GCM, CREDENTIALS_KEY) en `clave_cifrada`. Nunca en claro, ni en la base
-- ni en los logs ni en las respuestas: al panel solo llegan los últimos 4 caracteres.
CREATE TABLE IF NOT EXISTS clave_ia_estudio (
  -- Una sola fila: el CHECK impide una segunda.
  id             text        PRIMARY KEY DEFAULT 'estudio' CHECK (id = 'estudio'),
  clave_cifrada  text        NOT NULL,
  ultimos4       text        NOT NULL,
  -- 'invalida' = Anthropic la rechazó (revocada, sin permisos): un administrador debe reemplazarla.
  estado         text        NOT NULL DEFAULT 'activa' CHECK (estado IN ('activa', 'invalida')),
  -- Quién la configuró (correo), para saber a quién preguntar. No es un dato sensible.
  actualizado_por text       NOT NULL,
  actualizado    timestamptz NOT NULL DEFAULT now()
);

-- El navegador nunca habla con esta tabla (solo el servidor, con el rol de la app): RLS activo
-- y sin políticas para anon/authenticated.
ALTER TABLE clave_ia_estudio ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agente_contable_app') THEN
    DROP POLICY IF EXISTS app_total ON clave_ia_estudio;
    CREATE POLICY app_total ON clave_ia_estudio FOR ALL TO agente_contable_app USING (true) WITH CHECK (true);
    GRANT SELECT, INSERT, UPDATE, DELETE ON clave_ia_estudio TO agente_contable_app;
  END IF;
END $$;
