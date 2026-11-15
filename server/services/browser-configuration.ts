import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { AppError } from "../lib/errors.js";
import {
  parseJavaProperties,
  patchJavaProperties,
} from "../lib/java-properties.js";
import { resolveInside } from "../lib/paths.js";

export interface BrowserFileChange {
  path: string;
  before: string | null;
  after: string | null;
}
export interface OwnedSetting {
  path: string;
  keys: string[];
  before?: unknown;
  after: unknown;
}

export async function browserConfigurationPath(
  root: string,
  relative: string,
): Promise<string> {
  const resolved = await resolveInside(root, relative, false);
  let current = root;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new AppError(
          409,
          "browser_linked_configuration",
          "Browser gateway configuration must not contain filesystem links.",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return resolved;
}

export async function readConfiguration(
  root: string,
  relative: string,
): Promise<string | null> {
  const target = await browserConfigurationPath(root, relative);
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000)
      throw new AppError(
        409,
        "browser_unsafe_configuration",
        "A browser gateway configuration is linked, invalid, or too large.",
      );
    return await readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeConfiguration(
  root: string,
  relative: string,
  content: string | null,
): Promise<void> {
  let target = await browserConfigurationPath(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  target = await browserConfigurationPath(root, relative);
  if (content === null) {
    await unlink(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return;
  }
  const temporary = `${target}.nodepilot-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export function patchYaml(
  text: string | null,
  keys: string[],
  value: unknown,
): { text: string; previous: unknown } {
  const document = parseDocument(text ?? "", { uniqueKeys: true });
  if (document.errors.length)
    throw new AppError(
      409,
      "browser_invalid_yaml",
      "Repair the server YAML configuration before setting up browser access.",
    );
  const previous = document.getIn(keys);
  const plain =
    previous && typeof previous === "object" && "toJSON" in previous
      ? (previous as { toJSON(): unknown }).toJSON()
      : previous;
  if (value === undefined) {
    document.deleteIn(keys);
    for (let depth = keys.length - 1; depth > 0; depth -= 1) {
      const parent = keys.slice(0, depth);
      const node = document.getIn(parent) as { items?: unknown[] } | undefined;
      if (node?.items?.length === 0) document.deleteIn(parent);
    }
  } else document.setIn(keys, value);
  return { text: document.toString(), previous: plain };
}

/** Restore only owned keys, preserving unrelated edits Minecraft or the owner made. */
export function restoreSettings(
  text: string,
  settings: OwnedSetting[],
  properties: boolean,
): string {
  let output = text;
  for (const setting of settings) {
    const current = properties
      ? parseJavaProperties(output)[setting.keys[0]]
      : patchYaml(output, setting.keys, setting.after).previous;
    if (JSON.stringify(current) !== JSON.stringify(setting.after))
      throw new AppError(
        409,
        "browser_configuration_conflict",
        `The owned setting ${setting.keys.join(".")} was edited externally. Restore it before disabling browser access.`,
      );
    output = properties
      ? patchJavaProperties(
          output,
          setting.before === undefined
            ? {}
            : { [setting.keys[0]]: String(setting.before) },
          setting.before === undefined ? [setting.keys[0]] : [],
        )
      : patchYaml(output, setting.keys, setting.before).text;
  }
  return output;
}
