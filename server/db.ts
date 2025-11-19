import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleSQLite } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as sqliteSchema from "@shared/schema-sqlite";
import * as pgSchema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Check if using SQLite or PostgreSQL
const isSQLite = process.env.DATABASE_URL.startsWith('file:');

let pool: Pool | null = null;
let sqliteDb: any = null;

let db: any;

if (isSQLite) {
  // SQLite setup
  const dbPath = process.env.DATABASE_URL.replace('file:', '');
  sqliteDb = new Database(dbPath);
  db = drizzleSQLite(sqliteDb, { schema: sqliteSchema });
} else {
  // PostgreSQL setup
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  db = drizzle(pool, { schema: pgSchema });
}

export { db, pool, sqliteDb };