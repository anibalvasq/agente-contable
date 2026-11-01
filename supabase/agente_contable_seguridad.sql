-- Aislamiento del estudio dentro de un proyecto de Supabase compartido.
-- Todo el sistema vive en el esquema `agente_contable`; `public` (y lo que haya en él)
-- no se toca. Se aplica DESPUÉS de las migraciones 0001-0004 con
-- `SET search_path = agente_contable`.
--
-- Capas:
--  1. `agente_contable` no está en los esquemas expuestos de la API (PostgREST), así que
--     nadie llega a estas tablas por la API pública aunque tenga un JWT válido.
--  2. anon/authenticated no tienen ningún permiso aquí, y RLS está activo sin
--     políticas para ellos: doble candado.
--  3. El servidor entra con un rol propio (`agente_contable_app`) que solo ve este esquema.
--     El rol se crea SIN contraseña: se la pone una persona en el editor SQL
--     (ALTER ROLE agente_contable_app PASSWORD '...'), así nunca pasa por un chat ni por el repo.

REVOKE ALL ON SCHEMA agente_contable FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA agente_contable FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA agente_contable FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA agente_contable FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agente_contable_app') THEN
    CREATE ROLE agente_contable_app LOGIN;
  END IF;
END $$;

ALTER ROLE agente_contable_app SET search_path = agente_contable;
GRANT USAGE ON SCHEMA agente_contable TO agente_contable_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA agente_contable TO agente_contable_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA agente_contable TO agente_contable_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA agente_contable TO agente_contable_app;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'agente_contable' LOOP
    EXECUTE format('ALTER TABLE agente_contable.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS app_total ON agente_contable.%I', t);
    EXECUTE format('CREATE POLICY app_total ON agente_contable.%I FOR ALL TO agente_contable_app USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- El trigger solo usa NEW y now(): con search_path vacío no depende de ningún esquema
-- (lo marca el revisor de seguridad de Supabase como "function_search_path_mutable").
ALTER FUNCTION agente_contable.touch_updated_at() SET search_path = '';
