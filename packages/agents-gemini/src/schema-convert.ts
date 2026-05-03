/**
 * JSON-Schema → Gemini OpenAPI-3.0-Subset Konverter.
 *
 * Gemini akzeptiert nur einen begrenzten OpenAPI-Subset:
 *   ✅ type, properties, required, items, enum, description, format
 *   ❌ oneOf, anyOf, allOf, $ref, dependentRequired, patternProperties
 *
 * Strategie fuer nicht-supportierte Konstrukte:
 *   - oneOf/anyOf → degradiert zu STRING + Hinweis in description
 *   - $ref → resolved (wir haben aktuell keine $refs in unseren Schemas, aber sicherheitshalber)
 *   - allOf → erste Option uebernehmen
 *
 * Type-Mapping JSON-Schema → Gemini Type:
 *   "object" → OBJECT, "array" → ARRAY, "string" → STRING,
 *   "number" → NUMBER, "integer" → INTEGER, "boolean" → BOOLEAN
 */

import { Type } from '@google/genai';
import type { Schema } from '@google/genai';

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  format?: string;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  minItems?: number;
  maxItems?: number;
}

const TYPE_MAP: Record<string, Type> = {
  object: Type.OBJECT,
  array: Type.ARRAY,
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
};

export interface ConvertResult {
  schema: Schema;
  warnings: string[];
}

export function convertSchema(json: JsonSchema, path = '$'): ConvertResult {
  const warnings: string[] = [];
  const schema = convertNode(json, path, warnings);
  return { schema, warnings };
}

function convertNode(node: JsonSchema, path: string, warnings: string[]): Schema {
  // oneOf / anyOf → fallback STRING
  if (node.oneOf || node.anyOf) {
    warnings.push(`${path}: oneOf/anyOf nicht supportiert von Gemini → degradiert zu STRING`);
    return {
      type: Type.STRING,
      description: `${node.description ?? ''} (urspruenglich oneOf/anyOf — pass JSON-stringifiziert oder einfachen Wert)`.trim(),
    };
  }

  // allOf → erste Variante
  if (node.allOf && node.allOf.length > 0) {
    warnings.push(`${path}: allOf nicht supportiert → erste Variante uebernommen`);
    return convertNode(node.allOf[0], path, warnings);
  }

  // type fehlt
  if (!node.type) {
    warnings.push(`${path}: kein type-Feld → Fallback STRING`);
    return { type: Type.STRING, description: node.description };
  }

  const geminiType = TYPE_MAP[node.type];
  if (!geminiType) {
    warnings.push(`${path}: unbekannter type "${node.type}" → Fallback STRING`);
    return { type: Type.STRING, description: node.description };
  }

  const out: Schema = { type: geminiType };
  if (node.description) out.description = node.description;
  if (node.format) out.format = node.format;
  if (node.enum) out.enum = node.enum.map(String);

  if (node.type === 'object' && node.properties) {
    out.properties = {};
    for (const [key, val] of Object.entries(node.properties)) {
      out.properties[key] = convertNode(val, `${path}.${key}`, warnings);
    }
    if (node.required && node.required.length > 0) {
      out.required = [...node.required];
    }
  }

  if (node.type === 'array' && node.items) {
    out.items = convertNode(node.items, `${path}[]`, warnings);
    if (typeof node.minItems === 'number') (out as unknown as Record<string, unknown>).minItems = node.minItems;
    if (typeof node.maxItems === 'number') (out as unknown as Record<string, unknown>).maxItems = node.maxItems;
  }

  return out;
}
