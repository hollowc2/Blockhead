import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { logger } from "../logger.js";

/**
 * SQLite handle wrapper. Owns the connection, pragmas that matter for a
 * long-running agent (WAL so restarts are crash-safe), and sequential
 * migration application tracked via `PRAGMA user_version`.
 */
export class AppDatabase {
  readonly sql: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.sql = new Database(path);
    this.sql.pragma("journal_mode = WAL");
    this.sql.pragma("foreign_keys = ON");
    logger.info({ path }, "database opened");
  }

  /** Apply migrations with a higher index than `user_version`, each in a transaction. */
  runMigrations(migrations: readonly string[]): void {
    const current = this.sql.pragma("user_version", { simple: true }) as number;
    for (let i = current; i < migrations.length; i++) {
      const apply = this.sql.transaction(() => {
        this.sql.exec(migrations[i]!);
        this.sql.pragma(`user_version = ${i + 1}`);
      });
      apply();
    }
    logger.info({ from: current, to: migrations.length }, "database migrated");
  }

  close(): void {
    this.sql.close();
  }
}