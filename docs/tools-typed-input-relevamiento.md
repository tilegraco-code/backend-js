# Relevamiento: migrar tools a input tipado (determinístico)

> Objetivo: que cada tool declare en n8n **los campos que recibe** (input schema), en
> vez del actual `input` string único que el agente tiene que rellenar con un JSON.
> Elimina el error "Expected string, received object" y saca la dependencia del humor
> del modelo. Cada tool ya se formatea por separado en el backend → encaja natural.

---

## 1. Cómo funciona HOY

- `syncAgentTools` ([dashboard `lib/n8n.ts`](../../dashboard-tilegra/lib/n8n.ts)) crea **un nodo genérico** `toolHttpRequest` por tool, con **un solo parámetro `input` (string)**.
- El nodo postea a `app.tilegra.com/api/tools/run?tool_id=X` con `{ input: "<texto>" }`.
- `runTool` ([dashboard `lib/tools.ts`](../../dashboard-tilegra/lib/tools.ts)) recibe `input: string` y cada executor lo **parsea/interpreta** (JSON.parse + heurísticas).
- Problema: el schema dice `input: string`; si el modelo manda un objeto, n8n lo rechaza antes de llamarnos.

## 2. Cómo quedaría (propuesto)

- `syncAgentTools` define, por tool, un **input schema tipado** (JSON Schema) con los campos reales de esa acción → el toolHttpRequest de n8n soporta `specifyInputSchema` + `inputSchema`.
- El modelo completa **campos tipados** (string/number/array/...) y n8n los valida; manda el objeto estructurado al backend.
- `runTool` pasa un **objeto** (no string) a cada executor; los executors **leen campos directos** (sin JSON.parse ni heurísticas).
- Las descripciones dejan de tener que explicar el formato JSON (lo hace el schema); quedan solo "qué hace" + descripción por campo.

---

## 3. Inventario tool por tool (campos a declarar)

Leyenda: **req** = requerido · **opt** = opcional · (config) = ya viene de la config del tool, el modelo no lo manda.

### google_sheet
| Acción | Campos del modelo | Notas |
|---|---|---|
| `read_data` | *(ninguno)* | sheet + tab están en config. El agente solo invoca. |
| `append_row` | **dinámico**: una field por cada columna incluida (`config.columns` con `include=true`); nombre = nombre de columna, descripción = la que cargó el usuario; todas string | **Schema dinámico** según config. Es el caso más distinto. |
| `update_cells` | `range` (string, req), `values` (array de arrays, req) | Sin UI aún. `values` es matriz → schema con array anidado. |
| `create_sheet` | `title` (string, req) | |
| `find_sheet` | `name` (string, req) | |

### google_calendar
| Acción | Campos del modelo | Notas |
|---|---|---|
| `list_events` | `time_min` (string fecha, req), `time_max` (string fecha, req) | |
| `check_availability` | `time_min` (req), `time_max` (req) | **Esta es la que está fallando hoy.** |
| `create_event` | `summary` (req), `start` (datetime, req), `end` (datetime, req), `attendees` (array<email>, opt), `description` (opt), `location` (opt) | timezone (config). `attendees` es array. |
| `update_event` | `event_id` (req), `start`/`end`/`summary`/`description`/`location`/`attendees` (todos opt) | |
| `delete_event` | `event_id` (req) | |

### cal_com
| Acción | Campos del modelo | Notas |
|---|---|---|
| `get_event_types` | *(ninguno)* | |
| `get_availability` | `event_type_id` (number, opt si está en config), `start` (fecha, req), `end` (fecha, opt), `timezone` (opt) | |
| `create_booking` | `event_type_id` (number, opt/config), `start` (datetime, req), `attendee_name` (req), `attendee_email` (email, req), `timezone` (opt), `notes` (opt) | |
| `reschedule_booking` | `booking_uid` (req), `new_start` (datetime, req), `reason` (opt) | |
| `cancel_booking` | `booking_uid` (req), `reason` (opt) | |
| `list_bookings` | `status` (opt), `limit` (number, opt) | |

### tiendanube
| Acción | Campos del modelo | Notas |
|---|---|---|
| `search_products` | `query` (string, opt) | Hoy acepta texto pelado; pasaría a campo `query`. |
| `get_orders` | `status` (string, opt) | |
| `get_cart` | *(ninguno)* | |
| `create_checkout` | `name` (req), `email` (email, req), `products` (array<{variant_id:number, quantity:number}>, req), `lastname` (opt), `phone` (opt), `note` (opt) | `products` es array de objetos → schema anidado. |

### http
| Caso | Campos del modelo | Notas |
|---|---|---|
| (genérico) | `input` (string) único | **Caso especial:** la URL/headers/body los define el usuario con `{{input}}`. Es el "comodín" freeform → conviene **dejarlo con un solo `input` string** (acá sí tiene sentido). |

---

## 4. Cambios transversales necesarios

1. **`lib/n8n.ts` → `syncAgentTools`** (el corazón del cambio)
   - Reemplazar el `parametersBody: [{name:"input"}]` por **`specifyInputSchema: true` + `inputSchema`** (JSON Schema) en el nodo `toolHttpRequest`.
   - Nueva función `buildToolInputSchema(tool)` que devuelve el JSON Schema por `type` + acción + config (incluye el caso **dinámico** de `append_row` desde `config.columns`).
   - Verificar el `typeVersion` del nodo que soporta input schema (hoy usamos 1.1; confirmar al implementar).

2. **`app/api/tools/run/route.ts`**
   - Pasar de leer `input` (string) a recibir el **objeto estructurado** que manda n8n (los campos del schema). Mantener `tool_id` en query.
   - Pasar ese objeto a `runTool`.

3. **`lib/tools.ts` → `runTool` + executors**
   - `runTool(toolId, args: Record<string, unknown>)` (antes `input: string`).
   - Cada executor (`runGoogleSheet`, `runGoogleCalendar`, `runCalCom`, `runTiendanube`) pasa a leer **campos tipados** directo. Se eliminan: `interpretGoogleSheetInput`, `interpretTiendanubeInput`, los `JSON.parse(input)`, `normalizeValues`, las heurísticas de "texto pelado".
   - `runHttp` se mantiene con `input` string (sigue interpolando `{{input}}`).

4. **`tool-form-dialog.tsx` (descripciones)**
   - Las `*_DESCRIPTIONS` se simplifican: ya no hace falta meter el JSON de ejemplo (el schema define los campos). Quedan "qué hace + cuándo usarla". Las descripciones por campo se pasan al schema (para append_row salen de `config.columns`).

5. **Re-sync obligatorio**
   - El schema vive en el nodo de n8n → **cada tool hay que re-sincronizarla** (re-guardar) para migrar. Plan: script o "tocar" cada tool, o re-guardar manualmente las pocas que hay.

---

## 5. Casos especiales a tener en cuenta

- **`append_row` (schema dinámico):** las fields salen de `config.columns` (las incluidas). Hay que generar el schema en runtime desde la config. Es el único con schema variable por tool.
- **Arrays/objetos anidados:** `create_event.attendees`, `tiendanube.create_checkout.products`, `update_cells.values`. JSON Schema los soporta; confirmar que el toolHttpRequest los expone bien al modelo.
- **`http`:** queda con `input` string único (es el comodín). No se migra.
- **Campos de config vs modelo:** `event_type_id`, `timezone`, `calendar_id`, `spreadsheet_id`, `sheet_name` NO son del modelo (van en config) → no van en el schema.
- **Compatibilidad:** mientras se migra, conviene que `runTool` acepte **ambos** (objeto nuevo y, si llega, el viejo `input` string) para no romper tools no re-sincronizadas.

---

## 6. Plan de implementación sugerido

1. `buildToolInputSchema(tool)` + cambio en `syncAgentTools` (el nodo pasa a input schema). Probar con UNA tool (ej. `check_availability`).
2. `/api/tools/run` + `runTool` aceptan objeto (con fallback al string viejo).
3. Migrar executors uno por uno: **Calendar** (el que duele) → TiendaNube → Cal.com → Sheets (append dinámico último).
4. Simplificar descripciones.
5. Re-sincronizar todas las tools + deploy (dashboard).
6. Borrar el código muerto (interpretadores, normalizeValues) al final.

**Riesgo principal:** el comportamiento exacto del `toolHttpRequest` con `inputSchema` (campos anidados, typeVersion). Conviene un spike corto con una tool antes de migrar todas.
