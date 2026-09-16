-- Configuración de casos para una aseguradora de autos. Ver docs/documentos-y-casos-plan.md.
--
-- Sirve para probar las fases 2 y 3 sin el editor del dashboard, y como base de la plantilla
-- "Aseguradora de autos". Idempotente: se puede correr de nuevo para pisar la configuración.
--
-- Uso: reemplazar 0 por el agent_id en la línea de abajo. Después de correrlo, refrescar el
-- runtime (POST /api/agents/:id/refresh-runtime) para que el agente tome las tools de casos.

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
   '[{"key":"numero","label":"Número de documento"},{"key":"nombre","label":"Apellido y nombre"}]'),
  ('licencia', 'Licencia de conducir', 'Licencia o carnet de conducir, de cualquier jurisdicción, frente o dorso.',
   '[{"key":"nombre","label":"Apellido y nombre"},{"key":"vencimiento","label":"Fecha de vencimiento","type":"date"},{"key":"clase","label":"Clase"}]'),
  ('cedula_verde', 'Cédula del vehículo', 'Cédula de identificación del automotor (verde o azul), frente o dorso.',
   '[{"key":"patente","label":"Dominio o patente"},{"key":"titular","label":"Titular"}]'),
  ('titulo', 'Título del automotor', 'Título de propiedad del automotor emitido por el registro.',
   '[{"key":"patente","label":"Dominio o patente"},{"key":"titular","label":"Titular"}]'),
  ('denuncia_policial', 'Denuncia policial', 'Denuncia o exposición hecha en una comisaría o fiscalía.',
   '[{"key":"patente","label":"Dominio o patente"},{"key":"fecha","label":"Fecha del hecho","type":"date"}]'),
  ('denuncia_siniestro', 'Denuncia de siniestro', 'Formulario de denuncia de siniestro de la aseguradora, completo y firmado.',
   '[{"key":"patente","label":"Dominio o patente"},{"key":"fecha","label":"Fecha del siniestro","type":"date"}]'),
  ('foto_danio', 'Fotos del daño', 'Foto del vehículo donde se ve el daño.', '[]'),
  ('foto_cristal', 'Fotos del cristal roto', 'Foto del parabrisas, luneta, ventanilla o techo dañado.', '[]'),
  ('foto_patente', 'Foto de la patente', 'Foto donde se lee la patente del vehículo.', '[{"key":"patente","label":"Dominio o patente"}]'),
  ('foto_faltante', 'Fotos de lo robado', 'Foto de donde estaba la parte robada (rueda, estéreo, espejo).', '[]'),
  ('presupuesto', 'Presupuesto de reparación', 'Presupuesto de un taller o cristalería.',
   '[{"key":"monto","label":"Monto total","type":"number"}]'),
  ('licencia_tercero', 'Licencia del tercero', 'Licencia de conducir del otro conductor involucrado.',
   '[{"key":"nombre","label":"Apellido y nombre"}]'),
  ('poliza_tercero', 'Póliza del tercero', 'Póliza o certificado de cobertura del otro vehículo.',
   '[{"key":"compania","label":"Compañía"},{"key":"patente","label":"Dominio o patente"}]')
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
       {"type": "cedula_verde", "checks": [{"field": "patente", "op": "equals", "value": "data.patente"}]},
       {"type": "licencia", "checks": [{"field": "vencimiento", "op": "after", "value": "data.fecha_siniestro"}]},
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
       {"type": "denuncia_policial", "checks": [{"field": "patente", "op": "equals", "value": "data.patente"}]},
       {"type": "denuncia_siniestro"},
       {"type": "dni", "min": 2, "hint": "Frente y dorso"},
       {"type": "cedula_verde", "checks": [{"field": "patente", "op": "equals", "value": "data.patente"}]},
       {"type": "titulo", "checks": [{"field": "patente", "op": "equals", "value": "data.patente"}]}
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
       {"type": "denuncia_policial", "checks": [{"field": "patente", "op": "equals", "value": "data.patente"}]},
       {"type": "foto_faltante", "min": 1},
       {"type": "cedula_verde", "checks": [{"field": "patente", "op": "equals", "value": "data.patente"}]},
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
       {"type": "licencia", "checks": [{"field": "vencimiento", "op": "after", "value": "data.fecha_siniestro"}]},
       {"type": "cedula_verde", "checks": [{"field": "patente", "op": "equals", "value": "data.patente"}]},
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
       {"type": "cedula_verde", "checks": [{"field": "patente", "op": "equals", "value": "data.patente"}]}
     ]
   }$json$)
) as c(key, label, description, position, definition)
on conflict (agent_id, key) do update
  set label = excluded.label, description = excluded.description, definition = excluded.definition,
      position = excluded.position, active = true, updated_at = now();
