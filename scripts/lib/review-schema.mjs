import { readFile } from 'node:fs/promises';

import { PluginError } from './errors.mjs';

const schemaUrl = new URL('../../schemas/review-output.schema.json', import.meta.url);
/** @type {Promise<any>|undefined} */
let cachedSchema;

export async function loadReviewOutputSchema() {
  if (!cachedSchema) cachedSchema = readFile(schemaUrl, 'utf8').then((contents) => {
    let schema;
    try { schema = JSON.parse(contents); } catch (error) { throw schemaError(error); }
    validateSchemaDefinition(schema);
    return Object.freeze(schema);
  }).catch((error) => { throw error instanceof PluginError ? error : schemaError(error); });
  return cachedSchema;
}

/** @param {unknown} value @param {any} schema */
export function validateJsonSchema(value, schema) {
  validateSchemaDefinition(schema);
  return matches(value, schema);
}

/** @param {any} value @param {any} schema @returns {boolean} */
function matches(value, schema) {
  if (schema.enum && !schema.enum.some((/** @type {any} */ item) => Object.is(item, value))) return false;
  if (schema.type === 'object') {
    if (!plainObject(value)) return false;
    const properties = schema.properties ?? {};
    if ((schema.required ?? []).some((/** @type {string} */ key) => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(properties, key))) return false;
    return Object.entries(properties).every(([key, child]) => !Object.hasOwn(value, key) || matches(value[key], child));
  }
  if (schema.type === 'array') return Array.isArray(value) && value.every((item) => matches(item, schema.items));
  if (schema.type === 'string') return typeof value === 'string';
  if (schema.type === 'integer') return Number.isSafeInteger(value) && (schema.minimum === undefined || value >= schema.minimum);
  return schema.enum !== undefined;
}

/** @param {any} schema */
function validateSchemaDefinition(schema) {
  if (!plainObject(schema)) throw schemaError();
  const allowed = new Set(['$schema', 'title', 'type', 'enum', 'required', 'properties', 'additionalProperties', 'items', 'minimum']);
  if (Object.keys(schema).some((key) => !allowed.has(key))) throw schemaError();
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) throw schemaError();
  if (schema.type !== undefined && !['object', 'array', 'string', 'integer'].includes(schema.type)) throw schemaError();
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string'))) throw schemaError();
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') throw schemaError();
  if (schema.minimum !== undefined && typeof schema.minimum !== 'number') throw schemaError();
  if (schema.type === 'array') { if (!plainObject(schema.items)) throw schemaError(); validateSchemaDefinition(schema.items); }
  if (schema.properties !== undefined) {
    if (!plainObject(schema.properties)) throw schemaError();
    for (const child of Object.values(schema.properties)) validateSchemaDefinition(child);
  }
}

/** @param {unknown} [cause] */
function schemaError(cause) { return new PluginError('REVIEW_SCHEMA_INVALID', 'The installed review output schema is invalid.', { category: 'configuration', remedy: 'Reinstall or repair schemas/review-output.schema.json.', ...(cause ? { cause } : {}) }); }
/** @param {unknown} value @returns {value is Record<string,any>} */
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
