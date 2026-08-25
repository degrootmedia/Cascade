/**
 * FileJournal: a per-turn undo safeguard.
 *
 * Each AI turn (`Agent.send`) is the atomic "undo" unit. Before a mutating
 * file tool runs, the agent snapshots the target file's previous state here.
 * If the user later hits "Undo", every file captured this turn is restored to
 * the state it had before the turn began — created files are removed, edited
 * files are rewritten with their old contents.
 *
 * Only the *first* snapshot of a given path within a turn is kept, so repeated
 * writes to the same file still roll back to its true pre-turn state.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface UndoOutcome {
  /** Number of files whose on-disk state was changed back. */
  restored: number;
  /** Absolute paths of the restored files. */
  files: string[];
}

export class FileJournal {
  /** absPath -> the file's bytes before this turn (null = it did not exist). */
  private snapshots = new Map<string, Buffer | null>();
  private active = false;

  /** Start capturing a fresh turn's mutations (discards the previous turn). */
  beginTurn(): void {
    this.snapshots.clear();
    this.active = true;
  }

  /** Record a file's pre-mutation state; first capture of a path wins. */
  snapshotFile(absPath: string): void {
    if (!this.active) return;
    if (this.snapshots.has(absPath)) return;
    let before: Buffer | null = null;
    try {
      if (fs.existsSync(absPath)) before = fs.readFileSync(absPath);
    } catch {
      before = null; // unreadable/binary → treat as absent; undo will leave it
    }
    this.snapshots.set(absPath, before);
  }

  hasChanges(): boolean {
    return this.snapshots.size > 0;
  }

  /** Restore every captured file to its pre-turn state. Idempotent-ish. */
  undo(): UndoOutcome {
    const files: string[] = [];
    // Reverse order so nested/parented paths resolve cleanly.
    for (const [absPath, before] of [...this.snapshots.entries()].reverse()) {
      try {
        if (before === null) {
          if (fs.existsSync(absPath)) {
            fs.rmSync(absPath, { force: true });
            files.push(absPath);
          }
        } else {
          fs.mkdirSync(path.dirname(absPath), { recursive: true });
          fs.writeFileSync(absPath, before);
          files.push(absPath);
        }
      } catch {
        // Leave un-restorable files alone rather than failing the whole undo.
      }
    }
    this.clear();
    return { restored: files.length, files };
  }

  clear(): void {
    this.snapshots.clear();
    this.active = false;
  }
}
