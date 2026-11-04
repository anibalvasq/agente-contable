# CLAUDE.md — guía para Claude Code

Este repo es **agente-contable**: el sistema del estudio Vergara y Vásquez Auditores. Un panel para el equipo, procesos de F29/Previred, reglas de derivación de correos, una bóveda cifrada de claves y un servidor MCP. Node 20 + TypeScript (ESM). Despliega en **Vercel** (panel + MCP) con **Supabase** (Postgres y Auth).

Nació de un boilerplate de agentes de WhatsApp; los canales de WhatsApp/GHL/Chatwoot/YCloud, la cola y Coolify ya se eliminaron. Queda Telegram como único canal de mensajería.

## Arquitectura (lo mínimo para orientarte)
- `panel/index.html` + `src/panel/` — el panel del estudio (`/panel`) y su API. Con Supabase Auth: solo entran miembros activos de la tabla `equipo`; los administradores crean cuentas desde "Accesos al panel".
- `src/auth/` — validación de sesiones de Supabase y administración del equipo. El navegador inicia sesión directo en Supabase; el servidor solo valida el token.
- `src/vercel.ts` + `api/index.ts` — la app que corre en Vercel (panel + MCP, sin canales). `src/dev.ts` es lo mismo en local (`npm run panel`).
- `src/empresas/`, `src/recordatorios/`, `src/correos/` — base de empresas, lista de recordatorios F29/Previred del mes (**no envía nada**) y clasificación de correos por reglas editables (`config/correo-reglas.yaml` o el panel).
- `src/credentials/` + `src/security/vault.ts` — claves de las empresas cifradas (AES-256-GCM) con `CREDENTIALS_KEY`. **Ninguna ruta ni herramienta del agente devuelve una clave**; solo código del servidor las lee. Se cargan con `npm run claves:importar`.
- `src/panel/claveIa.ts` + `anthropic.ts` — API key de Claude de **cada persona** (BYOK) para el asistente del panel: cifrada con la misma bóveda, nunca se devuelve (solo últimos 4), se descifra únicamente dentro de la request. Con Supabase Auth el asistente exige la key de quien pregunta (428 si falta); sin cuentas reales usa el LLM del estudio. No hay login con cuenta Pro/Max: la API de Anthropic no lo permite a terceros.
- `src/mcp/` — servidor MCP (`/mcp`, apagado sin `MCP_TOKEN`), solo lectura: el cliente conecta su propio Claude.
- `src/agent/` — el agente: `runner.ts` (loop de tool-calling), `llm.ts`, `prompt.ts`, `tools/` (incluye `tools/chile` con IVA, honorarios, PPM y vencimientos), `guards/`.
- `src/channels/` — Telegram (`ChannelAdapter` en `types.ts`). `src/index.ts` + `src/server.ts` corren canal + panel como proceso largo; Vercel no.
- `src/memory/` — store: `postgres` o `memory` (`STORE`). `src/db/`, `migrations/` — migraciones SQL.
- `supabase/agente_contable_seguridad.sql` — aislamiento del esquema `agente_contable` (RLS y rol `agente_contable_app`).
- `config/agent.yaml` — identidad, conocimiento y `guardrails` del agente.

## Base de datos
Todo vive en el esquema **`agente_contable`** del proyecto Supabase `control_procesos` (compartido con otra aplicación: **no tocar `public`**). La app se conecta con el rol `agente_contable_app` por el pooler. Las migraciones se aplican a mano (SQL Editor o MCP de Supabase) con `SET LOCAL search_path = agente_contable`; el runner `npm run migrate` es solo para un Postgres propio.

## Seguridad — lee esto antes de tocar el agente

Cuatro capas de defensa. Si agregas código, respétalas:

1. **`src/agent/guards/input.ts`** — normaliza el mensaje y marca intentos de manipulación.
2. **`src/agent/guards/untrusted.ts`** — vallado de contenido externo. **La regla más importante del repo.**
3. **`src/agent/tools/policy.ts`** — frena las herramientas de escritura.
4. **`src/agent/guards/output.ts`** — revisa la respuesta antes de enviarla.

Reglas que no se negocian:

- **Nunca metas instrucciones dentro de un payload de herramienta.** Los `run()` devuelven DATOS (`{ error: 'la_herramienta_fallo' }`), no órdenes. Qué hacer ante un error se define una sola vez, en el `system_prompt` de `agent.yaml`.
- **Toda herramienta nueva declara `sideEffect`.** `'write'` ante la duda.
- **`returnsUntrustedContent: true`** si el resultado puede traer texto escrito por un tercero (correo de un cliente, CRM, PDF, API externa). Es el caso más común y el que más se olvida.
- **Las herramientas de escritura validan sus argumentos contra la base de datos**, nunca confían en el número, precio o id que mandó el modelo.
- **El acceso al panel lo da la tabla `equipo`, no tener una cuenta de Supabase Auth.** El proyecto es compartido: cualquier otra cuenta debe recibir 403.
- **Las claves de empresas nunca salen del servidor** (ni por HTTP, ni por MCP, ni por herramientas del agente).
- **Ningún aviso automático sin freno** (todo mail va por `notifications/`, que agrupa y no repite) y **ningún webhook sin autenticar**.
- **El MCP es solo lectura.** Si agregas una herramienta MCP que escriba o envíe, requiere decisión explícita.

## Tareas comunes
- **Cambiar la personalidad del agente** → `config/agent.yaml`.
- **Cambiar reglas de derivación de correos** → `config/correo-reglas.yaml` o el panel (se validan al guardar).
- **Agregar una herramienta al agente** → copia un archivo de `src/agent/tools/examples/`, define `sideEffect`, `returnsUntrustedContent`, `definition` y `run`, y súmalo a `defaultTools` en `src/agent/tools/index.ts`.
- **Lista de recordatorios del mes** → `npm run recordatorios -- --mes=AAAA-MM`.
- **Probar el panel en local** → `npm run panel`.
- **Verificar** → `npm run typecheck` y `npm test`.
- **Desplegar** → push a la rama; Vercel despliega. `main` es producción. Variables de entorno en Vercel (ver `.env.example`).

## Reglas
- **Escribe en español neutro**, no rioplatense: "puedes" y no "podés", "ejecuta" y no "corré", "aquí" y no "acá". Ojo con los regex de `guards/input.ts`: ahí conviven las dos variantes a propósito.
- No pongas secretos en el código ni los commitees; van en `.env` (gitignoreado) y en las variables de Vercel.
- Mantén el estilo: identificadores en inglés o español según el módulo, comentarios y docs en español.
- Los comentarios explican **por qué**, no qué.
- Antes de dar por hecho un cambio, ejecuta `npm run typecheck` y `npm test`.
