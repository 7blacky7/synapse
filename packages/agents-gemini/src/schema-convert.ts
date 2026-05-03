/**
 * JSON-Schema → Gemini OpenAPI-Subset Konverter.
 *
 * Gemini Schema unterstuetzt (verifiziert in @google/genai 1.51.0 dist/genai.d.ts:9638):
 *   ✅ type, properties, required, items, enum, description, format
 *   ✅ anyOf (interpretiert wie oneOf — geht!)
 *   ✅ minItems/maxItems (als string laut SDK)
 *   ❌ allOf (wir nehmen erste Variante)
 *   ❌ $ref (wir resolven nicht — unsere Schemas haben aktuell keine)
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
  // oneOf → anyOf (Gemini interpretiert beides identisch laut Doku)
  // anyOf → anyOf direkt
  const variants = node.oneOf ?? node.anyOf;
  if (variants && variants.length > 0) {
    const out: Schema = {
      anyOf: variants.map((v, i) => convertNode(v, `${path}.anyOf[${i}]`, warnings)),
    };
    if (node.description) out.description = node.description;
    return out;
  }

  // allOf → erste Variante (nicht ideal, aber unsere Schemas nutzen das nicht)
  if (node.allOf && node.allOf.length > 0) {
    warnings.push(`${path}: allOf nicht supportiert → erste Variante uebernommen`);
    return convertNode(node.allOf[0], path, warnings);
  }

  // type fehlt → Fallback STRING
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
    // Gemini SDK erwartet minItems/maxItems als string
    if (typeof node.minItems === 'number') out.minItems = String(node.minItems);
    if (typeof node.maxItems === 'number') out.maxItems = String(node.maxItems);
  }

  return out;
}
