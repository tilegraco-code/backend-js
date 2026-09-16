-- Configuración de casos para una aseguradora de autos. Ver docs/documentos-y-casos-plan.md.
--
-- Sirve para probar las fases 2 y 3 sin el editor del dashboard, y como base de la plantilla
-- "Aseguradora de autos". Idempotente: se puede correr de nuevo para pisar la configuración.
--
-- La revisión de documentos es mínima (¿es lo que se pidió y se lee?): no extrae datos, así
-- que el catálogo no define campos y los tipos de caso no usan checks.
--
-- Uso: reemplazar 0 por el agent_id en la línea de abajo. Después de correrlo, refrescar el
-- runtime (POST /api/agents/:id/refresh-runtime) para que el agente tome las tools de casos.

-- Todo en una transacción: la tabla temporal vive hasta el commit, y si algo falla no queda
-- una configuración a medias.
begin;

create temporary table seed_target (agent_id integer) on commit drop;
insert into seed_target values (0);  -- ← agent_id

-- 1. Habilitar ----------------------------------------------------------------

insert into public.agent_case_settings (agent_id, enabled, number_prefix)
select agent_id, true, 'SIN' from seed_target
on conflict (agent_id) do update set enabled = true, number_prefix = excluded.number_prefix, updated_at = now();

-- 2. Catálogo de documentos ---------------------------------------------------

insert into public.agent_document_types (agent_id, key, label, description, fields)
select t.agent_id, d.key, d.label, d.description, d.fields::jsonb
from seed_target t
cross join (values
  ('dni', 'DNI', 'Documento nacional de identidad argentino, frente o dorso (tarjeta o libreta).',
   '[]'),
  ('licencia', 'Licencia de conducir', 'Licencia o carnet de conducir, de cualquier jurisdicción, frente o dorso.',
   '[]'),
  ('cedula_verde', 'Cédula del vehículo', 'Cédula de identificación del automotor (verde o azul), frente o dorso.',
   '[]'),
  ('titulo', 'Título del automotor', 'Título de propiedad del automotor emitido por el registro.',
   '[]'),
  ('denuncia_policial', 'Denuncia policial', 'Denuncia o exposición hecha en una comisaría o fiscalía.',
   '[]'),
  ('denuncia_siniestro', 'Denuncia de siniestro', 'Formulario de denuncia de siniestro de la aseguradora, completo y firmado.',
   '[]'),
  ('foto_danio', 'Fotos del daño', 'Foto del vehículo donde se ve el daño.', '[]'),
  ('foto_cristal', 'Fotos del cristal roto', 'Foto del parabrisas, luneta, ventanilla o techo dañado.', '[]'),
  ('foto_patente', 'Foto de la patente', 'Foto donde se lee la patente del vehículo.', '[]'),
  ('foto_faltante', 'Fotos de lo robado', 'Foto de donde estaba la parte robada (rueda, estéreo, espejo).', '[]'),
  ('presupuesto', 'Presupuesto de reparación', 'Presupuesto de un taller o cristalería.',
   '[]'),
  ('licencia_tercero', 'Licencia del tercero', 'Licencia de conducir del otro conductor involucrado.',
   '[]'),
  ('poliza_tercero', 'Póliza del tercero', 'Póliza o certificado de cobertura del otro vehículo.',
   '[]')
) as d(key, label, description, fields)
on conflict (agent_id, key) do update
  set label = excluded.label, description = excluded.description, fields = excluded.fields, updated_at = now();

-- 3. Tipos de caso ------------------------------------------------------------

insert into public.agent_case_types (agent_id, key, label, description, definition, position)
select t.agent_id, c.key, c.label, c.description, c.definition::jsonb, c.position
from seed_target t
cross join (values
  ('rotura_cristal', 'Rotura de cristal',
   'Rotura de parabrisas, luneta, ventanillas o techo de vidrio, sin robo.', 1,
   $json${
     "data": [
       {"key": "patente", "label": "Patente"},
       {"key": "fecha_siniestro", "label": "Fecha del siniestro", "type": "date"},
       {"key": "cristal", "label": "Qué cristal se rompió", "type": "enum", "options": ["parabrisas", "luneta", "lateral", "techo"]}
     ],
     "documents": [
       {"type": "foto_cristal", "min": 2, "hint": "Una de cerca y una donde se vea el auto completo"},
       {"type": "foto_patente"},
       {"type": "cedula_verde"},
       {"type": "licencia"},
       {"type": "presupuesto", "hint": "De una cristalería"}
     ]
   }$json$),
  ('robo_total', 'Robo total',
   'Robo del vehículo completo.', 2,
   $json${
     "data": [
       {"key": "patente", "label": "Patente"},
       {"key": "fecha_siniestro", "label": "Fecha del robo", "type": "date"},
       {"key": "lugar", "label": "Lugar del robo"}
     ],
     "documents": [
       {"type": "denuncia_policial"},
       {"type": "denuncia_siniestro"},
       {"type": "dni", "min": 2, "hint": "Frente y dorso"},
       {"type": "cedula_verde"},
       {"type": "titulo"}
     ]
   }$json$),
  ('robo_parcial', 'Robo parcial',
   'Robo de partes del vehículo: ruedas, estéreo, espejos, baterías.', 3,
   $json${
     "data": [
       {"key": "patente", "label": "Patente"},
       {"key": "fecha_siniestro", "label": "Fecha del robo", "type": "date"},
       {"key": "que_robaron", "label": "Qué robaron"}
     ],
     "documents": [
       {"type": "denuncia_policial"},
       {"type": "foto_faltante", "min": 1},
       {"type": "cedula_verde"},
       {"type": "presupuesto"}
     ]
   }$json$),
  ('choque', 'Choque',
   'Choque o accidente con daño al vehículo, con o sin otro vehículo involucrado.', 4,
   $json${
     "data": [
       {"key": "patente", "label": "Patente"},
       {"key": "fecha_siniestro", "label": "Fecha del choque", "type": "date"},
       {"key": "lugar", "label": "Lugar del choque"},
       {"key": "hubo_tercero", "label": "Hubo otro vehículo involucrado", "type": "boolean"},
       {"key": "hubo_heridos", "label": "Hubo heridos", "type": "boolean"}
     ],
     "documents": [
       {"type": "denuncia_siniestro"},
       {"type": "foto_danio", "min": 3, "hint": "Del daño, de frente y de costado"},
       {"type": "foto_patente"},
       {"type": "licencia"},
       {"type": "cedula_verde"},
       {"type": "licencia_tercero", "when": [{"field": "data.hubo_tercero", "op": "equals", "value": true}]},
       {"type": "poliza_tercero", "when": [{"field": "data.hubo_tercero", "op": "equals", "value": true}]},
       {"type": "denuncia_policial", "when": [{"field": "data.hubo_heridos", "op": "equals", "value": true}]}
     ]
   }$json$),
  ('granizo', 'Granizo',
   'Daño en el vehículo por granizo.', 5,
   $json${
     "data": [
       {"key": "patente", "label": "Patente"},
       {"key": "fecha_siniestro", "label": "Fecha de la tormenta", "type": "date"}
     ],
     "documents": [
       {"type": "foto_danio", "min": 4, "hint": "Techo, capot, baúl y laterales"},
       {"type": "foto_patente"},
       {"type": "cedula_verde"}
     ]
   }$json$)
) as c(key, label, description, position, definition)
on conflict (agent_id, key) do update
  set label = excluded.label, description = excluded.description, definition = excluded.definition,
      position = excluded.position, active = true, updated_at = now();

commit;

-- 4. Destino en Google (opcional) ---------------------------------------------
--
-- Requiere que el cliente tenga Google Drive conectado en Integraciones (toolkit googledrive de
-- Composio). Los ids salen de las URLs:
--   carpeta  https://drive.google.com/drive/folders/<drive_parent_id>
--   sheet    https://docs.google.com/spreadsheets/d/<sheet_id>/edit
-- sheet_tab es el nombre exacto de la pestaña. sheet_columns en null usa las columnas por
-- default (Número, Tipo, Estado, Abierto, Completado, Falta, Carpeta y un dato por columna).
--
-- update public.agent_case_settings
-- set drive_parent_id = '<id de la carpeta>',
--     sheet_id        = '<id del sheet>',
--     sheet_tab       = 'Reclamos',
--     sheet_columns   = null,
--     updated_at      = now()
-- where agent_id = 0;  -- ← agent_id
