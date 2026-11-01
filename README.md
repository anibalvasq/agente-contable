# agente-contable

Sistema del estudio Vergara y Vásquez Auditores: panel para el equipo, procesos de F29 y Previred, derivación de correos por reglas, bóveda cifrada de claves y un servidor MCP para que el cliente use su propio Claude.

**Stack:** Node 20 + TypeScript · Vercel (panel y MCP) · Supabase (Postgres y Auth).

## Qué hace

- **Panel (`/panel`)** — lotes de comprobantes, cuadre por cuenta, mantenedores y los procesos con IA. Ingreso con correo y contraseña; solo entran miembros activos del estudio. Los administradores crean cuentas desde *Accesos al panel*.
- **Recordatorios F29 / Previred** — calcula qué empresa debe qué cosa y cuándo, y arma la lista del mes. **No envía nada.** `npm run recordatorios -- --mes=2026-12`.
- **Derivación de correos** — clasifica un correo y lo asigna a la persona correcta según reglas editables (`config/correo-reglas.yaml` o el panel). Las consultas simples pueden quedar como borrador de la IA.
- **Bóveda de claves** — claves de SII, Previred y Defontana cifradas (AES-256-GCM). Nada las devuelve por HTTP ni por herramientas.
- **MCP (`/mcp`)** — herramientas de solo lectura (vencimientos, recordatorios, empresas, clasificar correo). Apagado sin `MCP_TOKEN`.

## Probar en local

```bash
npm install
cp .env.example .env     # en local no hace falta nada más; OPENROUTER_API_KEY solo para el asistente
npm run panel            # http://localhost:3000/panel
npm run typecheck && npm test
```

Sin Supabase configurado, el panel local entra sin clave (solo desarrollo) y guarda en `data/panel.json`.

## Configuración (Vercel + Supabase)

Las variables van en Vercel → Settings → Environment Variables, marcando Preview y Production. La lista y para qué sirve cada una está en `.env.example`. Lo imprescindible:

| Variable | Qué es |
|---|---|
| `STORE=postgres`, `DATABASE_URL`, `DATABASE_SSL=require` | Conexión al pooler de Supabase con el rol `agente_contable_app` |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | Login del panel (son públicas) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secreta.** Solo para crear cuentas |
| `CREDENTIALS_KEY` | Llave de cifrado de las claves de empresas. Si se pierde, no se recuperan |
| `MCP_TOKEN` | Token del servidor MCP |
| `SESSION_SECRET`, `NODE_ENV=production` | Sesiones y modo producción |
| `OPENROUTER_API_KEY` (opcional) | Solo para el asistente del panel, los borradores de correo y Telegram. Sin ella el resto funciona |

### Base de datos

Todo vive en el esquema `agente_contable` (el proyecto de Supabase es compartido con otra app: no se toca `public`). Las migraciones están en `migrations/` y el aislamiento (RLS y rol propio) en `supabase/agente_contable_seguridad.sql`. Se aplican con `SET LOCAL search_path = agente_contable`.

### Primer administrador

Registra una cuenta de Supabase Auth en la tabla `equipo` con rol `admin`, o ejecuta `npm run usuarios:crear-admin -- correo "Nombre"` (necesita la service role key en el `.env`).

## Comandos

| Comando | Para qué |
|---|---|
| `npm run panel` | Panel y MCP en local |
| `npm run dev` | Canal Telegram + panel como proceso largo |
| `npm run recordatorios` | Lista de recordatorios del mes |
| `npm run empresas:importar` | Arma la base de empresas desde las hojas F29, Previred y contactos (CSV) |
| `npm run claves:importar` | Guarda cifradas las claves de las empresas |
| `npm run usuarios:crear-admin` | Crea el primer administrador |
| `npm run migrate` | Migraciones, solo para un Postgres propio |
| `npm run typecheck` · `npm test` | Verificación |

## Seguridad

El acceso al panel lo da estar en la tabla `equipo`, no tener una cuenta de Auth. Las claves de empresas no salen del servidor. El MCP es de solo lectura. Detalle de las reglas en `CLAUDE.md`.

## Licencia

MIT (ver `LICENSE`).
