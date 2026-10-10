# remote-opencode (Discord bot)

Bot Discord para manejar OpenCode CLI remoto.

## Stack
- Node >=22 (corre con nvm v24), TypeScript ESM, discord.js v14.
- Entry: `src/cli.ts` → `npm run build` (tsc) → `dist/src/cli.js`.
- El servicio corre SIEMPRE desde `dist`, no desde `src`. Cambiar src y ademas dist (o `npm run build`) y reiniciar.

## Comandos
- `npm run build` — compila TS a dist.
- `npm test` (vitest).
- `npm start` — `node --no-deprecation dist/src/cli.js start`.
- Servicio: `systemctl restart remote-opencode` (systemd, /etc/systemd/system/, sin sudo funciona via polkit). Logs: `journalctl -u remote-opencode -f`.

## Convenciones
- Rama de trabajo: `felipe`. Nunca push a main.
- Sin comentarios de codigo.

## Arquitectura
- Estado en `~/.remote-opencode/data.json` (bindings por canal, hub, sesiones). Respaldar antes de editar.
- `src/commands/hub.ts`: `DEFAULT_MODEL` (default del hub).
- `src/commands/model.ts`: lista de modelos es DINAMICA via `opencode models` (cache 30s). No hay lista hardcodeada de modelos.
- Selector de modelo del hub: boton `model-hub` en `src/handlers/buttonHandler.ts`.

## Aprendizajes
- El default del hub es solo fallback: si data.json ya tiene `hub.model` y `bindings[].model`, esos mandan. Cambiar `DEFAULT_MODEL` no corrige canales existentes; hay que actualizar data.json.
- IDs de modelo deepseek: `deepseek/deepseek-flash` = display "DeepSeek V4.1 Flash"; `deepseek/deepseek-v4-pro`. `deepseek/deepseek-v4-flash` NO existe (nombre viejo, rompia sesiones). Verificar siempre con `opencode models`.
- opencode expone DOS familias de API: **legacy** (raiz, payload SSE en `properties`): `/event`, `/question`, `/permission`, `/session/...`; y **v2** (`/api/...`, payload en `data`): `/api/event`, `/api/question/request`, etc. El SSE del bot usa legacy. Reglas:
  - responder pregunta: `POST /question/{id}/reply` `{answers:string[][]}`; rechazar: `POST /question/{id}/reject`.
  - responder permiso: `POST /permission/{id}/reply` `{reply,message?}`.
  - listar: `GET /question` y `GET /permission` (devuelven array plano).
  - las rutas `/api/session/{sid}/question|permission/{id}/reply` NO sirven para los ids que llegan por el SSE legacy (404). Para preguntas, el store v2 viene vacio mientras el legacy tiene la pendiente.
- Probe inutil: body vacio da 400 en ambas familias (validan payload antes de buscar el request). Distinguir store = comparar `GET /question` vs `GET /api/question/request`.
- Schemas live del server: `curl http://127.0.0.1:<port>/doc` (OpenAPI JSON, 162 paths).
- Concurrencia: `opencode serve` (bot) y `opencode` local comparten `~/.local/share/opencode/opencode.db`; ids de sesion globales. `opencode --session <id>` / `opencode attach http://127.0.0.1:<port>` reusan la misma sesion.
- Sync a Discord (`sessionSync.ts`): trae `GET /session/{id}/message`, postea user+assistant nuevos y guarda cursor por canal (`syncCursors` en data.json). El cursor debe apuntar al **ultimo mensaje con texto**, nunca al ultimo a secas: un turno assistant vacio (aun sin persistir, o pregunta resuelta) se saltearia para siempre. Triggers: idle del backgroundWatcher (si no hay run activo), boton `sync_<id>`, `/session sync`, y backfill al resumir sesion.
- El historial de un run de Discord se marca como sincronizado (`markThreadSynced`) al terminar para no duplicar con el sync del watcher.
