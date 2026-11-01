-- Personas del estudio que pueden entrar al panel. La identidad (correo y clave)
-- la guarda Supabase Auth; aquí solo se decide QUIÉN tiene acceso y con qué rol.
--
-- Importante: el acceso se otorga por estar en esta tabla y activo, NO por tener
-- una cuenta de Auth. Si el proyecto de Supabase tiene otros usuarios (o permite
-- registrarse), esa gente puede iniciar sesión pero el servidor del estudio le
-- responde 403 porque no figura aquí.
CREATE TABLE IF NOT EXISTS equipo (
  user_id  uuid        PRIMARY KEY,
  email    text        NOT NULL UNIQUE,
  nombre   text        NOT NULL,
  rol      text        NOT NULL DEFAULT 'equipo' CHECK (rol IN ('admin', 'equipo')),
  activo   boolean     NOT NULL DEFAULT true,
  creado   timestamptz NOT NULL DEFAULT now()
);

-- Con Supabase, user_id apunta a auth.users y se borra junto con la cuenta. En un
-- Postgres común (Coolify, local) no existe el esquema auth y la tabla queda sin FK.
DO $$
BEGIN
  IF to_regclass('auth.users') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'equipo_user_id_fkey' AND conrelid = 'equipo'::regclass) THEN
    ALTER TABLE equipo ADD CONSTRAINT equipo_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE;
  END IF;
END $$;
