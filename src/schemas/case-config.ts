// Configuración de casos de un agente, tal como la edita el dashboard (tab "Casos").
// Ver docs/documentos-y-casos-plan.md.
//
// Se guarda entera en una sola operación y se valida acá, con el mismo esquema de la definición
// que usa el evaluador: el dashboard no puede guardar algo que después rompa un caso.
import { z } from 'zod';
import { caseDefinitionSchema } from './case-definition';

const KEY = /^[a-z][a-z0-9_]{0,49}$/;
const keySchema = z.string().regex(KEY, 'Clave inválida');

/** Acepta el id suelto o la URL que el usuario copia de Google. */
function googleId(kind: 'folder' | 'sheet') {
  return z
    .string()
    .trim()
    .nullable()
    .transform((v, ctx) => {
      if (!v) return null;
      const re = kind === 'folder' ? /\/folders\/([A-Za-z0-9_-]+)/ : /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/;
      const fromUrl = re.exec(v)?.[1];
      if (fromUrl) return fromUrl;
      if (/^[A-Za-z0-9_-]{10,}$/.test(v)) return v;
      ctx.addIssue({
        code: 'custom',
        message: kind === 'folder' ? 'No es un link de carpeta de Google Drive' : 'No es un link de Google Sheets',
      });
      return z.NEVER;
    });
}

export const caseSettingsSchema = z.object({
  enabled: z.boolean(),
  number_prefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,10}$/, 'El prefijo lleva de 1 a 10 letras o números'),
  drive_parent_id: googleId('folder'),
  sheet_id: googleId('sheet'),
  sheet_tab: z.string().trim().max(100).nullable().transform((v) => v || null),
});

export const caseConfigDocumentTypeSchema = z.object({
  key: keySchema,
  label: z.string().trim().min(1, 'El documento necesita un nombre'),
  description: z.string().trim().min(1, 'El documento necesita una descripción'),
});

export const caseConfigCaseTypeSchema = z.object({
  key: keySchema,
  label: z.string().trim().min(1, 'El tipo de caso necesita un nombre'),
  description: z.string().trim().min(1, 'El tipo de caso necesita una descripción'),
  active: z.boolean().default(true),
  definition: caseDefinitionSchema,
});

export const caseConfigSchema = z
  .object({
    settings: caseSettingsSchema,
    document_types: z.array(caseConfigDocumentTypeSchema).max(100),
    case_types: z.array(caseConfigCaseTypeSchema).max(50),
  })
  .superRefine((config, ctx) => {
    const docKeys = new Set<string>();
    config.document_types.forEach((d, i) => {
      if (docKeys.has(d.key)) ctx.addIssue({ code: 'custom', message: `Documento repetido: ${d.label}`, path: ['document_types', i] });
      docKeys.add(d.key);
    });

    const caseKeys = new Set<string>();
    config.case_types.forEach((c, i) => {
      if (caseKeys.has(c.key)) ctx.addIssue({ code: 'custom', message: `Tipo de caso repetido: ${c.label}`, path: ['case_types', i] });
      caseKeys.add(c.key);
      c.definition.documents.forEach((d, j) => {
        if (!docKeys.has(d.type)) {
          ctx.addIssue({
            code: 'custom',
            message: `«${c.label}» pide un documento que no está en la lista de documentos`,
            path: ['case_types', i, 'definition', 'documents', j, 'type'],
          });
        }
      });
      if (c.active && c.definition.documents.length === 0 && c.definition.data.length === 0) {
        ctx.addIssue({ code: 'custom', message: `«${c.label}» no pide ningún dato ni documento`, path: ['case_types', i] });
      }
    });

    const s = config.settings;
    if (s.enabled && config.case_types.filter((c) => c.active).length === 0) {
      ctx.addIssue({ code: 'custom', message: 'Para activar los casos hace falta al menos un tipo de caso activo', path: ['settings', 'enabled'] });
    }
    if (s.sheet_id && !s.sheet_tab) {
      ctx.addIssue({ code: 'custom', message: 'Indicá el nombre de la pestaña del Sheet', path: ['settings', 'sheet_tab'] });
    }
  });

export type CaseConfig = z.infer<typeof caseConfigSchema>;
/** Lo que entra antes de validar (el dashboard manda URLs, prefijo en minúscula, etc.). */
export type CaseConfigInput = z.input<typeof caseConfigSchema>;
