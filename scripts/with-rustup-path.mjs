import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: bun scripts/with-rustup-path.mjs <command> [...args]');
  process.exit(2);
}

const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo');
const cargoBin = join(cargoHome, 'bin');
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'PATH';
const pathValue = process.env[pathKey] || '';
const env = {
  ...process.env,
  [pathKey]: [cargoBin, pathValue].filter(Boolean).join(delimiter),
};

const projectTargetDir = join(process.cwd(), 'src-tauri', 'target.noindex');
const usesProjectCargoTarget =
  existsSync(join(process.cwd(), 'src-tauri', 'Cargo.toml')) &&
  shouldUseProjectTargetDir(args[0], args.slice(1));

if (usesProjectCargoTarget && !env.CARGO_TARGET_DIR) {
  env.CARGO_TARGET_DIR = projectTargetDir;
}

if (!existsSync(cargoBin)) {
  console.warn(`[with-rustup-path] Rustup bin directory not found: ${cargoBin}`);
}

const [command, ...commandArgs] = args;
const result = spawnSync(command, commandArgs, {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(`[with-rustup-path] Failed to run ${command}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);

function shouldUseProjectTargetDir(command, commandArgs) {
  const binary = basename(command).replace(/\.(cmd|exe|js)$/i, '');
  if (binary === 'tauri') return true;
  if (binary !== 'cargo') return false;

  const subcommand = commandArgs.find((arg) => !arg.startsWith('-'));
  return new Set([
    'build',
    'check',
    'clippy',
    'doc',
    'run',
    'test',
    'xwin',
  ]).has(subcommand);
}
