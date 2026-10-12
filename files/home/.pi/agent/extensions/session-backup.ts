import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_BACKUP_DIR = ".lambda/backup";

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** The entire command argument is a path, optionally wrapped in quotes. No shell expansion. */
function backupPath(args: string, cwd: string): string {
  let path = args.trim() || DEFAULT_BACKUP_DIR;
  if (path.startsWith('"') || path.startsWith("'")) {
    if (path.length < 2 || path.at(-1) !== path[0]) throw new Error("Unclosed directory quote");
    path = path.slice(1, -1);
  }
  if (!path || path.includes("\0")) throw new Error("Invalid backup directory");
  return resolve(cwd, expandHome(path));
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function sessionRoot(ctx: ExtensionCommandContext): string {
  const root = resolve(expandHome(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")), "sessions");
  const active = ctx.sessionManager.getSessionDir();
  // Default storage is grouped by cwd; never back up just the current project's bucket.
  // A custom session-dir is already a complete store, without cwd grouping.
  return active && !contains(root, resolve(active)) ? resolve(active) : root;
}

async function stat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Resolve existing ancestors too, so an alias cannot hide overlapping stores. */
async function canonicalPath(path: string): Promise<string> {
  const info = await stat(path);
  if (info) return realpath(path);
  const parent = dirname(path);
  if (parent === path) throw new Error(`Cannot resolve ${path}`);
  return join(await canonicalPath(parent), relative(parent, path));
}

async function checkSeparateStores(sessions: string, backup: string): Promise<void> {
  const [source, destination] = await Promise.all([canonicalPath(sessions), canonicalPath(backup)]);
  if (contains(source, destination) || contains(destination, source)) {
    throw new Error("Backup directory and session store must not overlap");
  }
}

async function requireDirectory(path: string): Promise<void> {
  const info = await stat(path);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Not a regular directory: ${path}`);
  }
}

/** Walk only session files, rejecting links rather than following them outside the store. */
async function sessionFiles(root: string): Promise<string[]> {
  await requireDirectory(root);
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(relative(root, path));
    }
  }
  await walk(root);
  return files.sort();
}

async function ensureDirectory(path: string): Promise<void> {
  const info = await stat(path);
  if (!info) await mkdir(path, { recursive: true, mode: 0o700 });
  await requireDirectory(path);
}

/** Check every target component before copying any files; never write through a link. */
async function checkTargets(root: string, files: string[]): Promise<void> {
  for (const file of files) {
    let path = root;
    const parts = file.split(sep);
    for (let index = 0; index < parts.length; index++) {
      path = join(path, parts[index]);
      const info = await stat(path);
      if (!info) continue;
      const valid = index === parts.length - 1 ? info.isFile() : info.isDirectory();
      if (info.isSymbolicLink() || !valid) throw new Error(`Unsafe target: ${path}`);
    }
  }
}

/** Refresh backups atomically per file; restore only missing files, never live session history. */
async function transfer(source: string, destination: string, restore: boolean): Promise<{ copied: number; skipped: number }> {
  const files = await sessionFiles(source);
  await ensureDirectory(destination);
  await checkTargets(destination, files);
  let copied = 0;
  let skipped = 0;
  for (const file of files) {
    const target = join(destination, file);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    if (restore) {
      try {
        await copyFile(join(source, file), target, constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        skipped++;
        continue;
      }
    } else {
      const temp = await mkdtemp(join(dirname(target), ".lambda-backup-"));
      try {
        const staged = join(temp, "session.jsonl");
        await copyFile(join(source, file), staged);
        await rename(staged, target);
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    }
    copied++;
  }
  return { copied, skipped };
}

export default function sessionBackup(pi: ExtensionAPI): void {
  let busy = false;
  for (const command of ["backup", "restore"] as const) {
    pi.registerCommand(command, {
      description: `${command === "backup" ? "Back up" : "Restore"} all Pi sessions [directory] (default: ${DEFAULT_BACKUP_DIR})`,
      handler: async (args, ctx) => {
        if (busy) {
          ctx.ui.notify("A session backup/restore is already running", "warning");
          return;
        }
        busy = true;
        try {
          await ctx.waitForIdle();
          const sessions = sessionRoot(ctx);
          const backup = backupPath(args, ctx.cwd);
          await checkSeparateStores(sessions, backup);
          const stored = join(backup, "sessions");
          if (command === "backup") {
            // Missing stores are an error, not an empty backup that looks successful.
            await requireDirectory(sessions);
            await ensureDirectory(backup);
          } else {
            await requireDirectory(backup);
          }
          const result = command === "backup"
            ? await transfer(sessions, stored, false)
            : await transfer(stored, sessions, true);
          const message = command === "backup"
            ? `Backed up ${result.copied} Pi sessions to ${backup}`
            : `Restored ${result.copied} Pi sessions from ${backup}; skipped ${result.skipped} existing files. Use /resume to open restored sessions.`;
          ctx.ui.notify(message, "info");
        } catch (error) {
          ctx.ui.notify(`/${command} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        } finally {
          busy = false;
        }
      },
    });
  }
}
