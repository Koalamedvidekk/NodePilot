#!/bin/sh
# Applies a previously verified NodePilot release. This script intentionally uses
# POSIX shell syntax: NodePilot supports Linux systems where /bin/sh is not Bash.
set -eu

usage() {
  echo "Usage: apply-update.sh --parent-pid <pid> --staged-dir <dir> --target-dir <dir> --update-root <dir> --backup-dir <dir>" >&2
  exit 2
}

fail() {
  echo "[NodePilot updater] $*" >&2
  exit 1
}

parent_pid=''
staged_arg=''
target_arg=''
update_root_arg=''
backup_arg=''
ready_arg=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --parent-pid) parent_pid=${2-}; shift 2 ;;
    --staged-dir) staged_arg=${2-}; shift 2 ;;
    --target-dir) target_arg=${2-}; shift 2 ;;
    --update-root) update_root_arg=${2-}; shift 2 ;;
    --backup-dir) backup_arg=${2-}; shift 2 ;;
    --ready-file) ready_arg=${2-}; shift 2 ;;
    *) usage ;;
  esac
done

[ -n "$parent_pid" ] && [ -n "$staged_arg" ] && [ -n "$target_arg" ] && [ -n "$update_root_arg" ] && [ -n "$backup_arg" ] || usage
case "$parent_pid" in ''|*[!0-9]*) usage ;; esac
[ "$parent_pid" -gt 1 ] || usage

canonical_directory() {
  [ -d "$1" ] || return 1
  (cd "$1" && pwd -P)
}

mkdir -p "$update_root_arg" "$backup_arg" || fail 'Unable to create the update working directories.'
staged=$(canonical_directory "$staged_arg") || fail 'The staged update directory does not exist.'
target=$(canonical_directory "$target_arg") || fail 'The NodePilot installation directory does not exist.'
update_root=$(canonical_directory "$update_root_arg") || fail 'The update directory could not be resolved.'
backup=$(canonical_directory "$backup_arg") || fail 'The backup directory could not be resolved.'

case "$target" in /|.) fail 'Refusing to update an unsafe installation directory.' ;; esac
[ "${#target}" -ge 4 ] || fail 'Refusing to update an unsafe installation directory.'
case "$staged" in "$update_root"/staged/*) ;; *) fail 'The staged update is outside NodePilot update storage.' ;; esac
case "$backup" in "$update_root"/backups/*) ;; *) fail 'The backup is outside NodePilot update storage.' ;; esac
case "$target" in "$update_root"|"$update_root"/*) fail 'The installation directory cannot be inside its update storage.' ;; esac

log_file="$update_root/apply-update.log"
exec >>"$log_file" 2>&1
echo "[NodePilot updater] $(date -u '+%Y-%m-%dT%H:%M:%SZ') applying staged update."

files_tmp=$(mktemp "$update_root/.nodepilot-update-files.XXXXXX") || fail 'Unable to create a temporary manifest list.'
old_files_tmp=$(mktemp "$update_root/.nodepilot-previous-files.XXXXXX") || fail 'Unable to create a temporary manifest list.'
trap 'rm -f "$files_tmp" "$old_files_tmp"' 0 1 2 15

write_manifest_file_list() {
  source_dir=$1
  node --input-type=module - "$source_dir" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2]);
const protectedPathSegments = new Set(['.nodepilot', '.git', 'node_modules', '.env']);
const required = ['package.json', 'package-lock.json', 'server/index.ts', 'scripts/bootstrap.ps1', 'scripts/bootstrap.sh', 'scripts/apply-update.ps1', 'scripts/apply-update.sh', 'start.bat', 'start.sh'];

function fail(message) {
  process.stderr.write(`[NodePilot updater] ${message}\n`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(root, 'nodepilot-release.json'), 'utf8'));
} catch {
  fail('Release manifest is missing or invalid.');
}
if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) {
  fail('Release manifest has an unsupported format.');
}

const files = [];
const seen = new Set();
for (const entry of manifest.files) {
  if (typeof entry !== 'string' || entry.length === 0 || /[\x00-\x1f\x7f]/.test(entry) || entry.includes('\\') || entry.startsWith('/') || /^[A-Za-z]:/.test(entry)) {
    fail('Release manifest contains an unsafe path.');
  }
  const parts = entry.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..' || protectedPathSegments.has(part.toLowerCase()))) {
    fail('Release manifest contains an unsafe or protected path.');
  }
  const normalized = entry.toLocaleLowerCase('en-US');
  if (seen.has(normalized)) fail('Release manifest contains duplicate paths.');
  seen.add(normalized);
  const absolute = path.resolve(root, ...parts);
  if (!absolute.startsWith(root + path.sep)) fail('Release manifest path escapes the release directory.');
  let info;
  try {
    info = fs.lstatSync(absolute);
  } catch {
    fail(`Release package is missing ${entry}.`);
  }
  if (!info.isFile() || info.isSymbolicLink()) fail(`Release package contains an unsafe file: ${entry}.`);
  files.push(entry);
}
for (const entry of required) {
  if (!seen.has(entry)) fail(`Release package is missing required file ${entry}.`);
}
process.stdout.write(`${files.join('\n')}\n`);
NODE
}

write_manifest_file_list "$staged" >"$files_tmp" || fail 'The staged update could not be validated.'

if [ -n "$ready_arg" ]; then
  node --input-type=module - "$ready_arg" "$update_root" "$$" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const file = path.resolve(process.argv[2]);
const root = path.resolve(process.argv[3]);
if (path.dirname(file) !== root || !/^helper-ready-[A-Za-z0-9-]+\.json$/.test(path.basename(file))) {
  throw new Error('Invalid updater readiness path.');
}
fs.writeFileSync(file, JSON.stringify({ ready: true, pid: Number(process.argv[4]) }), { flag: 'wx', mode: 0o600 });
NODE
fi

wait_for_parent() {
  attempts=0
  while kill -0 "$parent_pid" 2>/dev/null; do
    if [ "$attempts" -ge 120 ]; then
      fail 'NodePilot did not exit within 60 seconds; the installation was not changed.'
    fi
    sleep 0.5
    attempts=$((attempts + 1))
  done
}

is_protected_root() {
  case "$1" in .nodepilot|.git|node_modules|.env) return 0 ;; *) return 1 ;; esac
}

remove_application_contents() {
  for entry in "$target"/* "$target"/.[!.]* "$target"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name=${entry##*/}
    is_protected_root "$name" && continue
    rm -rf -- "$entry"
  done
}

backup_application="$backup/application"

restore_previous_application() {
  echo '[NodePilot updater] Restoring the previous application files.'
  remove_application_contents
  if [ -d "$backup_application" ]; then
    for entry in "$backup_application"/* "$backup_application"/.[!.]* "$backup_application"/..?*; do
      [ -e "$entry" ] || [ -L "$entry" ] || continue
      name=${entry##*/}
      is_protected_root "$name" && continue
      cp -RP -- "$entry" "$target/$name"
    done
  fi
  if command -v npm >/dev/null 2>&1; then
    (cd "$target" && npm ci --include=dev) || echo '[NodePilot updater] Dependency restoration failed; inspect the backup and log.'
  fi
}

relaunch_application() {
  if [ -f "$target/start.sh" ] && command -v bash >/dev/null 2>&1; then
    nohup bash "$target/start.sh" >>"$update_root/relaunch.log" 2>&1 &
  else
    (cd "$target" && nohup npm run start >>"$update_root/relaunch.log" 2>&1 &)
  fi
  echo '[NodePilot updater] Relaunch requested; output is in relaunch.log.'
}

copy_manifest_files() {
  while IFS= read -r relative_path; do
    [ -n "$relative_path" ] || continue
    source_file="$staged/$relative_path"
    destination_file="$target/$relative_path"
    [ -f "$source_file" ] || fail "Staged release file is missing: $relative_path"
    mkdir -p -- "$(dirname "$destination_file")"
    cp -f -- "$source_file" "$destination_file"
  done <"$files_tmp"
  cp -f -- "$staged/nodepilot-release.json" "$target/nodepilot-release.json"
}

remove_stale_release_files() {
  [ -s "$old_files_tmp" ] || return 0
  while IFS= read -r relative_path; do
    [ -n "$relative_path" ] || continue
    if ! grep -F -x -- "$relative_path" "$files_tmp" >/dev/null 2>&1; then
      rm -f -- "$target/$relative_path"
    fi
  done <"$old_files_tmp"
}

wait_for_parent

old_lock_hash=''
if [ -f "$target/package-lock.json" ]; then
  old_lock_hash=$(node -e "const fs=require('node:fs');const crypto=require('node:crypto');process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" "$target/package-lock.json")
fi

if ! mkdir -p "$backup_application"; then
  fail 'Unable to create the application backup.'
fi
for entry in "$target"/* "$target"/.[!.]* "$target"/..?*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  name=${entry##*/}
  is_protected_root "$name" && continue
  cp -RP -- "$entry" "$backup_application/$name"
done

if [ -f "$backup_application/nodepilot-release.json" ]; then
  write_manifest_file_list "$backup_application" >"$old_files_tmp" || : >"$old_files_tmp"
fi

if ! copy_manifest_files || ! remove_stale_release_files; then
  echo '[NodePilot updater] Copying the verified release failed.'
  restore_previous_application || true
  relaunch_application
  exit 1
fi

new_lock_hash=$(node -e "const fs=require('node:fs');const crypto=require('node:crypto');process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" "$target/package-lock.json")
if [ "$old_lock_hash" != "$new_lock_hash" ] || [ ! -d "$target/node_modules" ]; then
  echo '[NodePilot updater] Installing dependencies for the new release.'
  if ! (cd "$target" && npm ci --include=dev); then
    echo '[NodePilot updater] Dependency installation failed.'
    restore_previous_application || true
    relaunch_application
    exit 1
  fi
fi

echo '[NodePilot updater] Building NodePilot before restart.'
if ! (cd "$target" && npm run build); then
  echo '[NodePilot updater] Build failed.'
  restore_previous_application || true
  relaunch_application
  exit 1
fi
if [ ! -f "$target/server/dist/index.js" ] || [ ! -f "$target/client/dist/index.html" ]; then
  echo '[NodePilot updater] Build outputs are missing.'
  restore_previous_application || true
  relaunch_application
  exit 1
fi

echo '[NodePilot updater] Update applied successfully; relaunching NodePilot.'
rm -rf -- "$staged"
relaunch_application
