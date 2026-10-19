import { AppError } from './errors.js';

const DANGEROUS_JVM_PREFIXES = [
  '-xx:onerror=',
  '-xx:onoutofmemoryerror=',
  '-agentpath:',
  '-agentlib:',
  '-javaagent:',
  '-xbootclasspath',
  '-xrun',
];

/**
 * Parses user input for memory (e.g. "2G", "4G", "2048M", "4096") into megabytes.
 * Returns null if input is null or undefined.
 */
export function parseMemoryMb(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined || input === '') {
    return null;
  }

  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input) || input < 256 || input > 65_536) {
      throw new AppError(400, 'invalid_memory_range', `Memory allocation must be between 256 MB and 65,536 MB (64 GB). Received ${input} MB.`);
    }
    return input;
  }

  const trimmed = input.trim();
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(g|gb|m|mb)?$/i.exec(trimmed);
  if (!match) {
    throw new AppError(400, 'invalid_memory_format', `Invalid memory format "${input}". Valid examples: 2G, 4G, 2048M.`);
  }

  const value = parseFloat(match[1]);
  const unit = (match[2] ?? 'm').toLowerCase();
  let mb: number;

  if (unit.startsWith('g')) {
    mb = Math.round(value * 1024);
  } else {
    mb = Math.round(value);
  }

  if (!Number.isSafeInteger(mb) || mb < 256 || mb > 65_536) {
    throw new AppError(400, 'invalid_memory_range', `Memory allocation must be between 256 MB and 65,536 MB (64 GB). Received ${mb} MB.`);
  }

  return mb;
}

/**
 * Formats megabytes into a human-readable string (e.g. 2048 -> "2G", 2500 -> "2500M").
 */
export function formatMemoryMb(mb: number | null | undefined): string {
  if (mb === null || mb === undefined) return '';
  if (mb % 1024 === 0) return `${mb / 1024}G`;
  return `${mb}M`;
}

/**
 * Validates custom JVM arguments for safety and structure.
 * Prevents shell injection, duplicate heap flags, and code execution vectors.
 */
export function validateCustomJvmArgs(args: string[]): string[] {
  if (!Array.isArray(args)) {
    throw new AppError(400, 'invalid_jvm_args', 'Custom JVM arguments must be an array of strings.');
  }

  if (args.length > 50) {
    throw new AppError(400, 'too_many_jvm_args', 'Too many custom JVM arguments (maximum 50).');
  }

  const validated: string[] = [];

  for (const raw of args) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) continue;

    if (trimmed.length > 256) {
      throw new AppError(400, 'jvm_arg_too_long', `JVM argument exceeds 256 characters: "${trimmed.slice(0, 30)}..."`);
    }

    // Shell safety check: Disallow characters that could indicate command injection if mishandled
    if (/[\0\r\n;&|`$><]/.test(trimmed)) {
      throw new AppError(400, 'unsafe_jvm_arg', `JVM argument contains unsafe characters: "${trimmed}"`);
    }

    // Heap flag deduplication: -Xms and -Xmx are managed through the dedicated memory inputs
    if (/^-Xm[sx]/i.test(trimmed)) {
      throw new AppError(
        400,
        'duplicate_heap_arg',
        `Heap memory flags (${trimmed}) must be configured using the Minimum and Maximum Heap settings.`,
      );
    }

    // Prohibit arbitrary code execution hooks
    const lower = trimmed.toLowerCase();
    for (const prefix of DANGEROUS_JVM_PREFIXES) {
      if (lower.startsWith(prefix)) {
        throw new AppError(400, 'prohibited_jvm_arg', `The JVM argument "${trimmed}" is not permitted for security reasons.`);
      }
    }

    // Must start with - or @ (e.g., -XX:+UseG1GC, -Dprop=val, @argsfile)
    if (!trimmed.startsWith('-') && !trimmed.startsWith('@')) {
      throw new AppError(
        400,
        'invalid_jvm_arg_format',
        `JVM arguments must begin with "-" or "@" (e.g. -XX:+UseG1GC, -Dlog4j2.formatMsgNoLookups=true). Received "${trimmed}".`,
      );
    }

    validated.push(trimmed);
  }

  return validated;
}
