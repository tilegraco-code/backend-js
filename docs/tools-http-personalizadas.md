# Tools HTTP personalizadas ("API personalizada")

Una tool `type = 'http'` en `agent_tools` deja que el agente llame a una API del cliente. Se configura en el dashboard (`/tasks` → **Herramientas** → *API personalizada*, o el botón **+ API** del panel de la derecha).

## Flujo

```
dashboard (config + secreto) ──► agent_tools.config / agent_tools.secret
runtime-config ──► api_tools[{ id, name, description, type:'http', config }]   (sin secreto)
agente-tilegra: _http_tool() arma los args del modelo desde config.params
   └─ el modelo la usa ──► POST backend-js /api/tools/http/run { tool_id, client_id, args }
                              └─ loadHttpTool (verifica dueño) + executeHttpTool ──► API del cliente
```

El secreto (token / API key / contraseña) **solo lo lee backend-js**. No vuelve al navegador (`toPublicTool` lo saca y expone `has_secret`) ni viaja al runtime.

## Config (`HttpConfig`)

| Campo | Qué es |
|---|---|
| `url`, `method` | `{nombre}` en la URL = parámetro de ruta |
| `params[]` | `{ name, type: string\|number\|boolean, description, required, location: path\|query\|body }` — es lo que ve el modelo |
| `auth` | `none` · `bearer` · `header {name}` · `query {name}` · `basic {username}` |
| `headers`, `query_params`, `body_template` | valores fijos, **no secretos** (el body fijo es un objeto JSON que se mezcla con los params de body) |

## Seguridad

- **Anti-SSRF** (`http-tool.request.ts`): solo `http(s)`; se bloquean loopback, redes privadas, link-local (metadata de la nube), CGNAT, multicast, IPv6 locales. La IP se valida en el `lookup` del socket (no antes), así que un DNS que cambia entre chequeo y conexión no lo esquiva. Las IP literales se validan aparte (Node no llama a `lookup`). Las redirecciones no se siguen.
- Timeout 15 s, descarga cortada en 1 MB, respuesta al modelo recortada a 4000 caracteres.
- Credenciales en la URL (`https://u:p@…`) se rechazan: van en Autenticación.

## Probar

`POST /api/tools/http/test` (backend-js) ejecuta una config sin guardar. El dashboard lo expone en `/api/tools/http/test` (con sesión); si se está editando y no se escribe un secreto nuevo, usa el guardado de `tool_id`.

## Tipos nativos que ya no corren

`google_sheet`, `google_calendar` y `cal_com` eran de n8n. El runtime de LangGraph los ignora; el dashboard ya no los ofrece y los existentes se ven como *No disponible* en el panel. Esas apps se usan por Composio.

## Migración

`db/migrations/agent_tools_secret.sql` — agrega `agent_tools.secret`. Tiene que estar aplicada antes de deployar el dashboard (si no, guardar una API con autenticación falla).
