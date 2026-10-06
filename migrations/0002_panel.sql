-- Documentos del panel del estudio (/panel): clientes y lotes de comprobantes.
-- Se guardan como JSON porque su forma la define el panel, no el agente.
CREATE TABLE IF NOT EXISTS panel_docs (
  collection  text        NOT NULL,
  id          text        NOT NULL,
  data        jsonb       NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
);
