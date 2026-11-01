import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';
import { isInside } from './paths.js';

type PropertyLine = { raw: string; key?: string; value?: string };

function unescapeProperty(value: string): string {
  return value.replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (_match, escaped: string) => {
    if (escaped[0] === 'u' && escaped.length === 5) return String.fromCharCode(parseInt(escaped.slice(1), 16));
    return ({ t: '\t', r: '\r', n: '\n', f: '\f' } as Record<string, string>)[escaped] ?? escaped;
  });
}

function propertyLines(text: string): PropertyLine[] {
  const physical = text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter((line) => line.length > 0) ?? [];
  const records: PropertyLine[] = [];
  for (let index = 0; index < physical.length; index += 1) {
    let raw = physical[index];
    let line = raw.replace(/[\r\n]+$/, '');
    if (/^[ \t\f]*(?:[#!]|$)/.test(line)) { records.push({ raw }); continue; }
    while ((line.match(/\\+$/)?.[0].length ?? 0) % 2 === 1 && index + 1 < physical.length) {
      const next = physical[++index];
      raw += next;
      line = line.slice(0, -1) + next.replace(/[\r\n]+$/, '').replace(/^[ \t\f]+/, '');
    }
    line = line.replace(/^[ \t\f]+/, '');
    if (!line || line.startsWith('#') || line.startsWith('!')) { records.push({ raw }); continue; }
    let boundary = line.length;
    for (let offset = 0; offset < line.length; offset += 1) {
      if (line[offset] === '\\') { offset += 1; continue; }
      if (/[=: \t\f]/.test(line[offset])) { boundary = offset; break; }
    }
    let valueOffset = boundary;
    while (/[ \t\f]/.test(line[valueOffset] ?? '') && valueOffset < line.length) valueOffset += 1;
    if (line[valueOffset] === '=' || line[valueOffset] === ':') valueOffset += 1;
    while (/[ \t\f]/.test(line[valueOffset] ?? '') && valueOffset < line.length) valueOffset += 1;
    records.push({ raw, key: unescapeProperty(line.slice(0, boundary)), value: unescapeProperty(line.slice(valueOffset)) });
  }
  return records;
}

export function parseJavaProperties(text: string): Record<string, string> {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const line of propertyLines(text)) if (line.key !== undefined) values[line.key] = line.value ?? '';
  return values;
}

function escapeProperty(value: string, key = false): string {
  return value.replace(/[\\\t\n\r\f=:#! ]/g, (character, offset: number) => {
    if (character === '\\') return '\\\\';
    if (character === '\t') return '\\t';
    if (character === '\n') return '\\n';
    if (character === '\r') return '\\r';
    if (character === '\f') return '\\f';
    if (key || (character === ' ' && offset === 0)) return '\\' + character;
    return character;
  });
}

/** Patch named keys without dropping comments, unknown keys, or Java escaping. */
export function patchJavaProperties(text: string, changes: Record<string, string>, removeKeys: string[] = []): string {
  const newline = text.match(/\r\n|\r|\n/)?.[0] ?? '\n';
  const remaining = new Set(Object.keys(changes));
  const records = propertyLines(text);
  const removed = new Set(removeKeys);
  let output = records.map((record) => {
    if (record.key !== undefined && removed.has(record.key)) return '';
    if (record.key === undefined || !Object.prototype.hasOwnProperty.call(changes, record.key)) return record.raw;
    remaining.delete(record.key);
    return escapeProperty(record.key, true) + '=' + escapeProperty(changes[record.key]) + (/[\r\n]$/.test(record.raw) ? newline : '');
  }).join('');
  for (const key of remaining) {
    if (output && !/[\r\n]$/.test(output)) output += newline;
    output += escapeProperty(key, true) + '=' + escapeProperty(changes[key]) + newline;
  }
  return output;
}

export async function readWorldProperties(root: string): Promise<Record<string, string>> {
  const filePath = path.join(root, 'server.properties');
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000 || !isInside(await realpath(root), await realpath(filePath))) {
      throw new AppError(409, 'unsafe_world_properties', 'The server properties file is linked, invalid, or too large.');
    }
    return parseJavaProperties(await readFile(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}
