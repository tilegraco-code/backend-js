// Esquema de la definición de un tipo de caso. Ver docs/documentos-y-casos-plan.md.
//
// Un solo esquema para todo el sistema: el dashboard valida contra él antes de guardar
// (exportado como JSON Schema) y backend-js antes de evaluar. El runtime nunca lee la
// definición: recibe la evaluación ya calculada.
//
// Los operadores son un set CERRADO a propósito. Una configuración no puede romper el
// evaluador y cada falla se puede explicar en una frase.
import { z } from 'zod';

const KEY = /^[a-z][a-z0-9_]{0,49}$/;
const keySchema = z.string().regex(KEY, 'Solo minúsculas, números y guión bajo; empieza con letra');

/** Referencia a un dato del caso: "data.patente". */
export const DATA_REF = /^data\.([a-z][a-z0-9_]{0,49})$/;

export const fieldTypeSchema = z.enum(['string', 'date', 'number', 'boolean', 'enum']);
export type FieldType = z.infer<typeof fieldTypeSchema>;

export const dataFieldSchema = z
  .object({
    key: keySchema,
    label: z.string().min(1),
    type: fieldTypeSchema.default('string'),
    options: z.array(z.string().min(1)).min(1).optional(),
    required: z.boolean().default(true),
    hint: z.string().optional(),
  })
  .refine((f) => f.type !== 'enum' || (f.options?.length ?? 0) > 0, {
    message: 'Un dato de tipo opciones necesita al menos una opción',
    path: ['options'],
  });
export type DataField = z.infer<typeof dataFieldSchema>;

/** Condición sobre los datos del caso. Decide si un requisito aplica. */
export const conditionSchema = z.object({
  field: z.string().regex(DATA_REF, 'La condición tiene que referir a un dato: data.<clave>'),
  op: z.enum(['equals', 'not_equals', 'in', 'exists']),
  value: z.unknown().optional(),
});
export type Condition = z.infer<typeof conditionSchema>;

/** Validación de un dato extraído del documento, contra un literal o un dato del caso. */
export const checkSchema = z.object({
  field: keySchema,
  op: z.enum(['equals', 'not_equals', 'after', 'before', 'exists', 'in']),
  value: z.unknown().optional(),
  /** Mensaje para el cliente cuando falla. Si no viene, se arma uno. */
  message: z.string().optional(),
});
export type Check = z.infer<typeof checkSchema>;

export const documentRequirementSchema = z.object({
  type: z.string().regex(KEY, 'Elegí qué documento se pide'),
  label: z.string().min(1).optional(),
  hint: z.string().optional(),
  min: z.number().int().min(1).max(20).default(1),
  when: z.array(conditionSchema).default([]),
  checks: z.array(checkSchema).default([]),
});
export type DocumentRequirement = z.infer<typeof documentRequirementSchema>;

export const caseDefinitionSchema = z
  .object({
    data: z.array(dataFieldSchema).default([]),
    documents: z.array(documentRequirementSchema).default([]),
  })
  .superRefine((def, ctx) => {
    const keys = new Set<string>();
    def.data.forEach((f, i) => {
      if (keys.has(f.key)) {
        ctx.addIssue({ code: 'custom', message: `Dato repetido: ${f.key}`, path: ['data', i, 'key'] });
      }
      keys.add(f.key);
    });

    const checkRef = (value: unknown, path: (string | number)[]) => {
      if (typeof value !== 'string') return;
      const m = DATA_REF.exec(value);
      if (m && !keys.has(m[1])) {
        ctx.addIssue({ code: 'custom', message: `No existe el dato ${m[1]}`, path });
      }
    };

    def.documents.forEach((d, i) => {
      d.when.forEach((c, j) => {
        checkRef(c.field, ['documents', i, 'when', j, 'field']);
        if (c.op !== 'exists' && c.value === undefined) {
          ctx.addIssue({ code: 'custom', message: 'La condición necesita value', path: ['documents', i, 'when', j, 'value'] });
        }
        if (c.op === 'in' && !Array.isArray(c.value)) {
          ctx.addIssue({ code: 'custom', message: 'El operador in necesita una lista', path: ['documents', i, 'when', j, 'value'] });
        }
      });
      d.checks.forEach((c, j) => {
        checkRef(c.value, ['documents', i, 'checks', j, 'value']);
        if (c.op !== 'exists' && c.value === undefined) {
          ctx.addIssue({ code: 'custom', message: 'El check necesita value', path: ['documents', i, 'checks', j, 'value'] });
        }
        if (c.op === 'in' && !Array.isArray(c.value)) {
          ctx.addIssue({ code: 'custom', message: 'El operador in necesita una lista', path: ['documents', i, 'checks', j, 'value'] });
        }
      });
    });
  });
export type CaseDefinition = z.infer<typeof caseDefinitionSchema>;

/** Un tipo de documento del catálogo del agente. */
export const documentTypeSchema = z.object({
  key: keySchema,
  label: z.string().min(1),
  description: z.string().min(1),
  fields: z
    .array(z.object({ key: keySchema, label: z.string().min(1), type: fieldTypeSchema.default('string') }))
    .default([]),
});
export type DocumentType = z.infer<typeof documentTypeSchema>;

/**
 * Lo que se guarda en `chat_cases.requirements` al abrir un caso: la definición del tipo más
 * las entradas del catálogo que usa. Es una copia: si después cambia la configuración, el caso
 * abierto termina con las reglas con las que empezó.
 */
export const caseRequirementsSchema = z.object({
  case_type: keySchema,
  label: z.string(),
  definition: caseDefinitionSchema,
  catalog: z.record(documentTypeSchema),
});
export type CaseRequirements = z.infer<typeof caseRequirementsSchema>;
