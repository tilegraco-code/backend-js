// Plantillas de configuración de casos por rubro. El dashboard las carga en el editor como punto
// de partida; no se guarda nada hasta que el usuario guarda. Ver docs/documentos-y-casos-plan.md.
//
// La revisión de documentos es mínima (¿es lo que se pidió y se lee?): las plantillas no usan
// checks porque no se extraen datos contra los que comparar.
import type { CaseConfigInput } from './case-config';

type Template = { key: string; label: string; description: string; config: CaseConfigInput };

const patente = { key: 'patente', label: 'Patente', type: 'string' as const, required: true };

export const CASE_TEMPLATES: Template[] = [
  {
    key: 'aseguradora_autos',
    label: 'Aseguradora de autos',
    description: 'Reclamos por rotura de cristal, robo, choque y granizo.',
    config: {
      settings: { enabled: true, number_prefix: 'SIN', drive_parent_id: null, sheet_id: null, sheet_tab: null },
      document_types: [
        { key: 'dni', label: 'DNI', description: 'Documento nacional de identidad argentino, frente o dorso (tarjeta o libreta).' },
        { key: 'licencia', label: 'Licencia de conducir', description: 'Licencia o carnet de conducir, de cualquier jurisdicción, frente o dorso.' },
        { key: 'cedula_verde', label: 'Cédula del vehículo', description: 'Cédula de identificación del automotor (verde o azul), frente o dorso.' },
        { key: 'titulo', label: 'Título del automotor', description: 'Título de propiedad del automotor emitido por el registro.' },
        { key: 'denuncia_policial', label: 'Denuncia policial', description: 'Denuncia o exposición hecha en una comisaría o fiscalía.' },
        { key: 'denuncia_siniestro', label: 'Denuncia de siniestro', description: 'Formulario de denuncia de siniestro de la aseguradora, completo y firmado.' },
        { key: 'foto_danio', label: 'Fotos del daño', description: 'Foto del vehículo donde se ve el daño.' },
        { key: 'foto_cristal', label: 'Fotos del cristal roto', description: 'Foto del parabrisas, luneta, ventanilla o techo dañado.' },
        { key: 'foto_patente', label: 'Foto de la patente', description: 'Foto donde se lee la patente del vehículo.' },
        { key: 'foto_faltante', label: 'Fotos de lo robado', description: 'Foto de donde estaba la parte robada (rueda, estéreo, espejo).' },
        { key: 'presupuesto', label: 'Presupuesto de reparación', description: 'Presupuesto de un taller o cristalería.' },
        { key: 'licencia_tercero', label: 'Licencia del tercero', description: 'Licencia de conducir del otro conductor involucrado.' },
        { key: 'poliza_tercero', label: 'Póliza del tercero', description: 'Póliza o certificado de cobertura del otro vehículo.' },
      ],
      case_types: [
        {
          key: 'rotura_cristal',
          label: 'Rotura de cristal',
          description: 'Rotura de parabrisas, luneta, ventanillas o techo de vidrio, sin robo.',
          active: true,
          definition: {
            data: [
              patente,
              { key: 'fecha_siniestro', label: 'Fecha del siniestro', type: 'date', required: true },
              { key: 'cristal', label: 'Qué cristal se rompió', type: 'enum', options: ['parabrisas', 'luneta', 'lateral', 'techo'], required: true },
            ],
            documents: [
              { type: 'foto_cristal', min: 2, hint: 'Una de cerca y una donde se vea el auto completo' },
              { type: 'foto_patente' },
              { type: 'cedula_verde' },
              { type: 'licencia' },
              { type: 'presupuesto', hint: 'De una cristalería' },
            ],
          },
        },
        {
          key: 'robo_total',
          label: 'Robo total',
          description: 'Robo del vehículo completo.',
          active: true,
          definition: {
            data: [
              patente,
              { key: 'fecha_siniestro', label: 'Fecha del robo', type: 'date', required: true },
              { key: 'lugar', label: 'Lugar del robo', type: 'string', required: true },
            ],
            documents: [
              { type: 'denuncia_policial' },
              { type: 'denuncia_siniestro' },
              { type: 'dni', min: 2, hint: 'Frente y dorso' },
              { type: 'cedula_verde' },
              { type: 'titulo' },
            ],
          },
        },
        {
          key: 'robo_parcial',
          label: 'Robo parcial',
          description: 'Robo de partes del vehículo: ruedas, estéreo, espejos, baterías.',
          active: true,
          definition: {
            data: [
              patente,
              { key: 'fecha_siniestro', label: 'Fecha del robo', type: 'date', required: true },
              { key: 'que_robaron', label: 'Qué robaron', type: 'string', required: true },
            ],
            documents: [{ type: 'denuncia_policial' }, { type: 'foto_faltante' }, { type: 'cedula_verde' }, { type: 'presupuesto' }],
          },
        },
        {
          key: 'choque',
          label: 'Choque',
          description: 'Choque o accidente con daño al vehículo, con o sin otro vehículo involucrado.',
          active: true,
          definition: {
            data: [
              patente,
              { key: 'fecha_siniestro', label: 'Fecha del choque', type: 'date', required: true },
              { key: 'lugar', label: 'Lugar del choque', type: 'string', required: true },
              { key: 'hubo_tercero', label: 'Hubo otro vehículo involucrado', type: 'boolean', required: true },
              { key: 'hubo_heridos', label: 'Hubo heridos', type: 'boolean', required: true },
            ],
            documents: [
              { type: 'denuncia_siniestro' },
              { type: 'foto_danio', min: 3, hint: 'Del daño, de frente y de costado' },
              { type: 'foto_patente' },
              { type: 'licencia' },
              { type: 'cedula_verde' },
              { type: 'licencia_tercero', when: [{ field: 'data.hubo_tercero', op: 'equals', value: true }] },
              { type: 'poliza_tercero', when: [{ field: 'data.hubo_tercero', op: 'equals', value: true }] },
              { type: 'denuncia_policial', when: [{ field: 'data.hubo_heridos', op: 'equals', value: true }] },
            ],
          },
        },
        {
          key: 'granizo',
          label: 'Granizo',
          description: 'Daño en el vehículo por granizo.',
          active: true,
          definition: {
            data: [patente, { key: 'fecha_siniestro', label: 'Fecha de la tormenta', type: 'date', required: true }],
            documents: [
              { type: 'foto_danio', min: 4, hint: 'Techo, capot, baúl y laterales' },
              { type: 'foto_patente' },
              { type: 'cedula_verde' },
            ],
          },
        },
      ],
    },
  },
];
