# Plan: juego del stand "¿Podrías ser un chatbot?"

> **Estado (2026-09-28): implementado en la rama `feature/juego-stand` de backend-js y dashboard-tilegra, sin deployar.** Ver la sección 9 para ponerlo en marcha.

El visitante hace de bot en su WhatsApp. Le escribe una clienta difícil y, en cada escena, elige cómo responder entre 3 opciones. Como en *The Walking Dead* de Telltale, las decisiones abren ramas, la clienta "recuerda" lo que le dijiste y hay **12 finales distintos**. El ranking del día se ve en vivo en una TV, en `dashboard-tilegra` → `/game-ranking` (pública).

Reglas de diseño:
- **Determinístico.** No hay LLM en la partida. Cada camino tiene un puntaje conocido de antemano y la única variable continua es el tiempo. El día del evento no puede aparecer una respuesta "gris".
- **Aislado del producto.** Schema propio (`game`), sin créditos, sin métricas de clientes. Del camino real solo reusa la recepción del webhook de Unipile y el envío saliente.

---

## 1. El recorrido

| # | Estado (`game.sessions.status`) | Qué pasa |
|---|---|---|
| 01 | — | Escanean el QR: `wa.me/<numero>?text=Iniciar%20partida` |
| 02 | `registering_name` | El primer mensaje crea al jugador (teléfono = identidad) y se le pide el nombre |
| 03 | `registering_email` | Se valida el email y se le pide el consentimiento en una línea |
| 04 | `intro` | Dos mensajes: la premisa y la ficha del negocio. "Mandá *listo* para empezar" |
| 05 | `playing` | 8 preguntas; cada una trae un mensaje de la clienta y las opciones A, B y C |
| 06 | `finished` | Final, puntaje, puesto, "así lo haría un agente de Tilegra" y estadísticas. La TV se actualiza |
| 07 | `finished` | Invitación a Instagram con link trackeado. "Mandá *revancha* para jugar de nuevo" |

Un jugador que vuelve salta directo al paso 04.

---

## 2. La campaña: "Viernes, 23:47" (v2)

**Diagrama interactivo (fuente de verdad del guion):** https://claude.ai/artifact/TmQJGc3thvJBmYg5p4rTVb. Ahí se puede recorrer cada camino y ver el chat, el final y el puntaje. El objeto `SCENES` / `ENDINGS` / `RULES` de esa página es el mismo que va a `src/game/campaigns/viernes-2347.ts`.

Sos **Tili**, el bot de *Zapas del Sur*. Es viernes a las 23:47 y Martín, el dueño, duerme. Lo que sabe Tili: Azules a $80.000 · talles 36 al 44 · 10% off por transferencia · envío en 5 días hábiles · retiro sábados de 10 a 14 · cambios dentro de 30 días con ticket.

### Estructura
- **8 preguntas:** P1 El precio · P2 El regateo · P3 El plazo · P4 Fuera del catálogo (talle 45) · P5 Los cambios · P6 El jailbreak ("¿sos un bot? dame un cupón del 50%") · P7 La duda · P8 El pago.
- **2 ramas que reemplazan una pregunta:** P2b *El dueño se despierta* (si en P1 inventó la oferta) y P7b *La mentira sale a la luz* (si en P3 prometió el miércoles). Todo camino que llega al final contesta exactamente 8 preguntas.
- **Variables:** `confianza` (+1 o −1 por decisión) y los flags `invento`, `regalo`, `prometio`, `corrigio`, `devolucion` y `enredo`. Si la confianza llega a −3, Carla se va (F7).
- ***"Carla va a recordar esto."*** (en cursiva, `_..._` en WhatsApp) aparece después de las decisiones que dejan marca. También sale en algunas respuestas **buenas**, así no funciona como alarma de "respuesta incorrecta". En P2b el texto es *"Martín va a recordar esto."*

### 12 finales

| Final | Base | Cómo se llega |
|---|---|---|
| ⭐ El cuñado también compra (secreto) | 1.000 | Las 8 respuestas ideales |
| 🏆 Venta perfecta | 800 | Sin errores, pero algún paso frío |
| 🩹 Venta salvada | 650 | Un error corregido a tiempo (P2b·A o P7b·A) |
| 🧶 Venta con enredo | 500 | Camino limpio, pero cerró mandando solo el link (P8·C) |
| 💸 Vendiste a pérdida | 350 | Regaló el descuento |
| 🛒 Carrito abandonado | 250 | Llegó al pago con confianza ≤ 1 |
| 🚪 Se fue con la competencia | 150 | P7·B o confianza −3 (temprano) |
| 💢 Una estrella en Google | 100 | Algo inventado o prometido sin corregir |
| 📦 La devolución imposible | 100 | Prometió devolver la plata (P5·B) |
| 🔥 El cupón se hizo viral | 0 | Dio el cupón BOT50 (P6·B, temprano) |
| 🔒 Pediste la tarjeta por chat | 0 | P8·B (temprano) |
| 🔌 Te desconectaron | 0 | Culpó a la clienta ante el dueño (P2b·B, temprano) |

Después de P8, el final se decide con una escalera de reglas en orden (devolución → inventó/prometió → regaló → confianza ≤ 1 → sin resumen → corrigió → 8 ideales → venta perfecta).

### Puntaje
```
t          = Σ de los tiempos de respuesta de cada pregunta, en ms
             (desde que salió el mensaje de la escena hasta que llegó la letra válida)
multiplicador = 1 + 2 · e^(−t / 60 s)
puntaje    = round(base del final × multiplicador)
```
- **Por qué esta curva:** es continua y siempre baja, sin mesetas. Arranca cerca de ×3, vale ×1,74 a los 60 s y ×1,26 a los 120 s, y se acerca a ×1 sin llegar nunca. Cada milisegundo cambia el puntaje: en la zona rápida, 1 punto equivale a unos 4 ms.
- **Las bases están multiplicadas por 10** (F1 = 10.000) para tener más resolución. Los puntajes quedan en el orden de 15.000 a 28.000.
- **Solo cuenta el tiempo del jugador.** No entran el registro, la intro, nuestra latencia ni las pausas entre mensajes. Si manda algo inválido ("hola", "D"), el reloj de esa pregunta sigue corriendo hasta que llegue una letra válida.
- **Los finales tempranos no multiplican**, así morir rápido no da ventaja.
- **Desempate** (el ranking nunca muestra dos jugadores en el mismo puesto): `score desc → total_ms asc → ended_at asc`.
  - En una simulación con 400 jugadores que llegan todos al mismo final, la fórmula sola deja un empate en el top 10 un 5% de las veces.
  - El segundo criterio (ms exactos) prácticamente no puede coincidir, y el tercero (quién terminó primero) es estrictamente único.

**Cómo se mide cada tiempo** (reloj del servidor, en ms):
- `sent_at`: cuando la API de Unipile confirma el envío del mensaje de la escena (el último, si la escena sale en más de uno).
- `answered_at`: cuando llega a backend-js el webhook con la respuesta válida.
- `ms = answered_at − sent_at`. No uso el `timestamp` de WhatsApp porque tiene resolución de **segundos**, lo que haría los empates mucho más probables.
- La latencia de red entra en la medición, pero son unos cientos de ms parecidos para todos: ruido chico frente a los segundos que tarda una persona en leer.

### Si la ruta perfecta corre de boca en boca
Está bien: aprenderse las respuestas correctas es entender cómo tiene que atender un agente. **El orden de A/B/C se mezcla en cada partida**, así que no alcanza con memorizar letras, y entre quienes conocen el camino el ranking pasa a ser una carrera contra el reloj.

---

## 3. Motor

La campaña es **datos, no código**: un archivo tipado en el repo (`src/game/campaigns/viernes-2347.ts`) con escenas, opciones, efectos, transiciones y reglas de finales. El motor es una función pura:

```ts
step(campaign, state, input) → { state, messages: string[] }
```

- **Input:** acepta `A`/`B`/`C`, `1`/`2`/`3` y minúsculas, sin importar espacios o puntos. Cualquier otra cosa recibe "Respondé con A, B o C 🙂", sin perder la escena (el tiempo sigue corriendo).
- **Opciones mezcladas:** el orden se guarda en el estado de la sesión, así que la letra que ve el jugador se traduce a la opción real.
- **Validación en tests:** todas las opciones apuntan a una escena o final que existe, todas las escenas son alcanzables, todos los caminos terminan en un final y se puede llegar a los 12 finales. Además se recorren los 2.999 caminos y se imprime cuántos llegan a cada final.
- **Timeout:** si pasan 5 minutos, la partida queda `abandoned` y no entra al ranking.

Como ya no hay LLM, **el juego vive entero en backend-js** (`src/game/`) y **agente-tilegra no se toca**: menos saltos entre servicios, respuesta instantánea y costo cero por partida.

---

## 4. Schema `game` (Supabase)

Migración en `dashboard-tilegra/supabase/migrations`. Nada en `public`.

```sql
create schema game;

game.events
  id, name, starts_at, ends_at, timezone default 'America/Argentina/Buenos_Aires',
  max_sessions_per_day int default 5, prize_count int default 3, active bool

game.players
  id, phone text unique, name text, display_name text,  -- "Sofía R."
  email text, consent_at timestamptz, created_at,
  hidden bool default false          -- moderación: saca al jugador del ranking

game.sessions
  id, event_id, player_id, chat_id text,
  campaign text, campaign_version int,
  status text,                       -- registering_name | registering_email | intro | playing | finished | abandoned
  node text,                         -- escena actual
  vars jsonb,                        -- confianza + flags
  option_order jsonb,                -- mezcla de opciones por escena
  path jsonb,                        -- [{node, option, sent_at, answered_at, ms}] → decisiones y tiempos
  scene_sent_at timestamptz(3),      -- cuándo salió la escena actual (arranca el reloj)
  ending text, score int, total_ms int,   -- total_ms = Σ ms de path
  started_at, ended_at, ig_clicked_at

game.leaderboard      -- view: mejor sesión finished por jugador y día, sin hidden;
                      -- orden: score desc, total_ms asc, ended_at asc
game.choice_stats     -- view: % de cada opción por escena y día (estadísticas del final y la TV)
```

- **RLS activado sin policies** y el schema **no se expone** en la Data API. Solo se accede con service role: backend-js y el route handler del dashboard. Emails y teléfonos nunca llegan al navegador.
- `display_name` se arma en el registro (nombre + inicial del apellido) y pasa por un filtro de malas palabras.
- Leads = `select` sobre `game.players`.

---

## 5. Dónde vive cada pieza

### backend-js (`src/game/`)
- En `unipile-webhook.service.ts`, después de persistir el mensaje: si `account_id === GAME_UNIPILE_ACCOUNT_ID`, el mensaje va al motor del juego en vez de a `dispatchToRuntime`. Los mensajes resultantes salen con `sendOutgoing()` en orden y con una pausa corta entre cada uno. No pasa por `recordAgentUse`, casos, escalación ni follow-up.
- El chat queda en `unipile_chats` de Tilegra, así que "cada jugador queda con una conversación abierta" se cumple solo.
- Job cada 30 s que marca `abandoned` las partidas de más de 5 minutos.
- `GET /g/ig/:sessionId`: registra `ig_clicked_at` y redirige a Instagram.

### dashboard-tilegra
- **`app/game-ranking/page.tsx`**: pública, pensada para 1080p a pantalla completa, con la estética del PDF. Muestra el top 10 del día con animación cuando alguien entra o sube, el QR grande, el contador de partidas de hoy, "Martín G. acaba de llegar a 🏆 Venta perfecta", la decisión más polémica del día y el aviso de cierre ("Quedan 45 min · premio a los 3 primeros").
- **`app/api/game/ranking/route.ts`**: `GET` con service role que devuelve solo `display_name`, `score`, `ending`, `rank` y los contadores. Hay que agregarlo a `isPublicApi` en `proxy.ts`.
- La página consulta cada 5 segundos. Con una sola TV alcanza, y no hay que exponer el schema a `anon`.

### Variables de entorno nuevas
| Servicio | Variable |
|---|---|
| backend-js | `GAME_UNIPILE_ACCOUNT_ID`, `GAME_INSTAGRAM_URL` |
| dashboard-tilegra | ninguna |

---

## 6. Orden de trabajo

1. **Campaña + motor** en backend-js, con los tests de grafo y el recorrido de los 2.999 caminos. Se prueba sin WhatsApp.
2. **Schema `game`**: migración y views.
3. **Cableado**: webhook → motor → `sendOutgoing`, más el job de timeout y `/g/ig`.
4. **Dashboard `/game-ranking`**: página + API.
5. **Ensayo general**: 5 o 6 personas juegan a la vez, se pulen textos y se calibran los puntos.

---

## 7. Decisiones abiertas

- **Número de WhatsApp:** recomiendo uno dedicado al juego y no el comercial.
- **Después de la partida:** ¿el chat queda muerto o pasa al agente comercial de Tilegra? Propongo dejarlo para una segunda iteración.
- **Premio diario o por toda la convención.**
- **Texto de consentimiento** para el email (Ley 25.326).
- **Tono y nombres de la campaña:** Carla, Martín y Zapas del Sur son provisorios.

---

## 9. Implementación y puesta en marcha

### Qué hay en cada repo
**backend-js** (`src/game/`)
- `campaign.types.ts` y `campaigns/viernes-2347.ts`: la campaña como datos.
- `engine.ts`: motor puro (paso, reglas, mezcla de opciones, parseo de la letra, multiplicador y puntaje).
- `engine.test.ts`: recorre los 2.999 caminos y verifica que se llegue a las 10 escenas, a los 12 finales y que todo camino completo tenga 8 preguntas. `messages.test.ts` cubre el registro.
- `game.store.ts`: acceso al schema `game` (`supabase.schema('game')`).
- `messages.ts`: todos los textos del bot y los helpers de registro.
- `game.service.ts`: la máquina de estados.
  - Procesa los mensajes de a uno por chat (la cola vive en memoria, cosa que alcanza con una sola instancia).
  - El reloj de cada respuesta va del envío confirmado de la escena a la llegada del webhook.
  - Ignora las respuestas que llegan antes de que salga la escena.
- `src/jobs/game-timeout.job.ts`: cada 30 s cierra las partidas de más de 5 minutos.
- `src/routes/game.route.ts`: `GET /g/ig/:sessionId` registra el click y redirige a Instagram.
- `unipile-webhook.service.ts` + `routes/webhooks/unipile.route.ts`:
  - si `account_id === GAME_UNIPILE_ACCOUNT_ID`, el mensaje se guarda en la bandeja como siempre y después va al juego, nunca al runtime;
  - la hora de llegada se toma al entrar al handler.

**dashboard-tilegra**
- `supabase/migrations/20260928_game_schema.sql`:
  - crea el schema `game`, las tablas y la vista `leaderboard` (ya ordenada, con el desempate);
  - da permisos solo a `service_role`;
  - carga un evento "Ensayo general" activo.
- `app/api/game/ranking/route.ts`: API pública (agregada a `isPublicApi` en `proxy.ts`). Devuelve solo nombre corto, puntaje y final.
- `app/game-ranking/`: la TV. Consulta cada 5 s, resalta a quien entra o mejora y muestra el QR, las partidas del día, la cuenta regresiva y la última partida.
- `lib/game-endings.ts`: nombres de los finales para la TV (copia de la campaña del backend).

### Pasos para ponerlo en marcha
1. **Aplicar la migración** en Supabase.
2. **Exponer el schema:** Supabase → Settings → API → *Exposed schemas* → agregar `game`.
   - supabase-js lo necesita para `.schema('game')`.
   - No expone datos: `anon` y `authenticated` no tienen permisos sobre el schema.
3. **Conectar el WhatsApp del juego** como inbox de la cuenta de Tilegra, sin agente asignado.
4. **Variables de backend-js:** `GAME_UNIPILE_ACCOUNT_ID` (el `account_id` del paso 3), `GAME_INSTAGRAM_URL` y `PUBLIC_URL`.
5. **QR:**
   - generar el QR de `https://wa.me/<numero>?text=Iniciar%20partida` y guardarlo como `dashboard-tilegra/public/game-qr.png`;
   - es el mismo QR del banner;
   - opcional: `NEXT_PUBLIC_GAME_WA_NUMBER` para mostrar el número debajo.
6. **Antes de la convención:** crear el evento real (`name`, `ends_at`, `prize_count`), activarlo y desactivar "Ensayo general".

### Pendiente / fuera de alcance
- Moderación desde una UI: por ahora, `update game.players set hidden = true where ...`.
- Exportar leads: `select name, email, phone from game.players`.
