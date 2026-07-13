# Meta CAPI — Nota para Marketing (config de GTM)

El equipo técnico ya dejó implementado el tracking de Meta con **deduplicación** (Conversions API server-side + pixel del navegador comparten el mismo `event_id`). Esta nota es lo que falta de tu lado en **Google Tag Manager**.

Pixel ID: **1045406298065448**

---

## Lo importante primero: cómo funciona el reparto

De los 8 eventos, **6 se mandan 100% desde el servidor** (no tocás nada en GTM, ya viajan solos a Meta) y **2 pasan por el navegador** (esos sí necesitan un tag en GTM).

| Evento (Meta) | Cómo se manda | ¿Necesita GTM? |
|---|---|---|
| **Lead** | Navegador (dataLayer) + server | ✅ Sí |
| **Agent_Drafted** | Navegador (dataLayer) + server | ✅ Sí |
| CompleteRegistration | 100% server | ❌ No |
| StartTrial | 100% server | ❌ No |
| InitiateCheckout | 100% server | ❌ No |
| Subscribe | 100% server | ❌ No |
| inbox_connected (custom) | 100% server | ❌ No |
| agent_activated (custom) | 100% server | ❌ No |

Así que en GTM solo tenés que configurar **2 eventos**. El resto ya está.

---

## Paso 0 — Base (una sola vez)

1. Tener el **pixel de Meta** cargado en GTM (tag base de Meta Pixel con el ID `1045406298065448`, disparando en All Pages). Esto es lo que setea las cookies `_fbp` / `_fbc` que el backend usa para el matching.
2. Crear una **Variable de capa de datos**:
   - Nombre en GTM: `DLV - event_id`
   - Nombre de la variable de capa de datos: `event_id`

Esa variable es la clave de la deduplicación: la vamos a pasar como *Event ID* en cada tag.

---

## Paso 1 — Evento: Lead

**Trigger (activador):**
- Tipo: *Custom Event*
- Nombre del evento: `lead_trigger`

**Tag:**
- Tipo: Meta Pixel → *Track* → **Lead**
- **Event ID:** `{{DLV - event_id}}`  ← imprescindible para deduplicar
- Activador: el trigger `lead_trigger` de arriba

---

## Paso 2 — Evento: Agent_Drafted

**Trigger (activador):**
- Tipo: *Custom Event*
- Nombre del evento: `agent_drafted_trigger`

**Tag:**
- Tipo: Meta Pixel → *Track Custom* → nombre del evento: **Agent_Drafted**
- Parámetro personalizado: `agent_type` (viene en la capa de datos)
- **Event ID:** `{{DLV - event_id}}`
- Activador: el trigger `agent_drafted_trigger`

---

## Cómo verificar que dedupca bien

1. En **Events Manager → Test Events**, hacé un signup de prueba y creá un agente.
2. Para `Lead` y `Agent_Drafted` deberías ver **un solo evento** con la etiqueta de que llegó por *Browser* **y** *Server* (Meta los unió por `event_id`). Si ves dos separados, el `event_id` no está mapeado igual en ambos lados.
3. Los otros 6 eventos van a aparecer como *Server* solamente — es lo esperado.

## Qué NO hacer

- No crees tags de GTM para los 6 eventos server-side (CompleteRegistration, StartTrial, InitiateCheckout, Subscribe, inbox_connected, agent_activated). Si los duplicás en el navegador **sin** el mismo `event_id`, Meta los va a contar dos veces.
