-- Claves de las empresas (SII, Previred, Defontana), SIEMPRE cifradas.
-- La llave de cifrado vive en la variable de entorno CREDENTIALS_KEY, no aquí:
-- un respaldo de esta tabla solo contiene texto ilegible (ver src/security/vault.ts).
CREATE TABLE IF NOT EXISTS empresa_credenciales (
  rut           text        NOT NULL,
  sistema       text        NOT NULL CHECK (sistema IN ('sii', 'previred', 'defontana')),
  clave_cifrada text        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rut, sistema)
);
