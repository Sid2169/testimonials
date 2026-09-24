// Database access: a connection pool, two tiny query helpers, and the schema
// migration. Everything in the app talks to MySQL through this file so SQL
// lives in exactly one place.

import mysql, { type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { config } from './config.js';

// A connection pool reuses a small set of open connections instead of
// opening a new one per query. `connectionLimit` caps that set; when all are
// busy, new queries wait (`waitForConnections`) up to `queueLimit`.
//
// timezone: 'Z' makes the driver treat DATETIME values as UTC, matching the
// UTC_TIMESTAMP() functions used by the SQL queries.
export const pool = mysql.createPool({
  host: config.DB_HOST, port: config.DB_PORT, user: config.DB_USER,
  password: config.DB_PASSWORD, database: config.DB_NAME,
  ssl: config.DB_SSL ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined,
  timezone: 'Z', charset: 'utf8mb4', connectionLimit: 10,
  waitForConnections: true, queueLimit: 100,
});

// The only value types a query is ever allowed to receive. Every dynamic
// value is passed through the `?` placeholders below, never spliced into the
// SQL string, which prevents SQL injection.
export type SqlValue = string | number | boolean | Date | null;

// Run a SELECT and return the rows. Generic over T so callers can get typed
// rows, e.g. rows<{ total: number }>('SELECT COUNT(*) AS total ...').
export async function rows<T>(sql: string, values: SqlValue[] = []): Promise<T[]> {
  const [result] = await pool.execute<RowDataPacket[]>(sql, values);
  return result as T[];
}

// Run a non-SELECT statement (INSERT/UPDATE/DELETE) and return metadata such
// as `affectedRows`, which callers use to detect "nothing matched".
export async function execute(sql: string, values: SqlValue[] = []) {
  const [result] = await pool.execute<ResultSetHeader>(sql, values);
  return result;
}

// Schema creation. Idempotent (CREATE TABLE IF NOT EXISTS), safe to run on
// every deploy. New schema changes should be added here as reviewed,
// idempotent steps rather than one-off manual SQL.
export async function migrate() {
  // Exactly one admin account. The CHECK constraint enforces id = 1 so a
  // second row can never be inserted accidentally.
  await execute(`CREATE TABLE IF NOT EXISTS admins (
    id TINYINT UNSIGNED PRIMARY KEY,
    email VARCHAR(254) NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,
    CONSTRAINT single_admin CHECK (id = 1)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // Server-side sessions. The raw token is never stored — only its SHA-256
  // hash (see auth.ts) — so a database leak would not reveal usable cookies.
  await execute(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) PRIMARY KEY,
    csrf_token CHAR(64) NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    INDEX idx_session_expiry (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // The testimonials themselves. `deleted_at` implements a soft delete:
  // rows are excluded everywhere while remaining recoverable in the DB.
  // status controls public visibility (only 'approved' is public).
  await execute(`CREATE TABLE IF NOT EXISTS testimonials (
    id CHAR(36) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    view TEXT NOT NULL,
    company VARCHAR(150) NOT NULL DEFAULT '',
    company_url VARCHAR(500) NOT NULL DEFAULT '',
    designation VARCHAR(150) NOT NULL DEFAULT '',
    linkedin VARCHAR(500) NOT NULL DEFAULT '',
    photo_filename VARCHAR(100) NULL,
    status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    latitude DECIMAL(6,3) NULL,
    longitude DECIMAL(6,3) NULL,
    location_accuracy DOUBLE NULL,
    client_submitted_at DATETIME(3) NOT NULL,
    client_timezone VARCHAR(100) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    deleted_at DATETIME(3) NULL,
    INDEX idx_public_date (deleted_at, status, created_at),
    INDEX idx_name (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // One-off lightweight migration: older databases created before the
  // company-page feature lack the `company_url` column. Detect it (without
  // assumptions) and add it, leaving existing rows valid due to the default.
  const [companyUrlColumn] = await rows<{ total: number }>(`SELECT COUNT(*) AS total
    FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'testimonials' AND column_name = 'company_url'`);
  if (!companyUrlColumn.total) {
    await execute("ALTER TABLE testimonials ADD COLUMN company_url VARCHAR(500) NOT NULL DEFAULT '' AFTER company");
  }
}