import mysql, { type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool({
  host: config.DB_HOST, port: config.DB_PORT, user: config.DB_USER,
  password: config.DB_PASSWORD, database: config.DB_NAME,
  ssl: config.DB_SSL ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined,
  timezone: 'Z', charset: 'utf8mb4', connectionLimit: 10,
  waitForConnections: true, queueLimit: 100,
});
export type SqlValue = string | number | boolean | Date | null;
export async function rows<T>(sql: string, values: SqlValue[] = []): Promise<T[]> {
  const [result] = await pool.execute<RowDataPacket[]>(sql, values);
  return result as T[];
}
export async function execute(sql: string, values: SqlValue[] = []) {
  const [result] = await pool.execute<ResultSetHeader>(sql, values);
  return result;
}

export async function migrate() {
  await execute(`CREATE TABLE IF NOT EXISTS admins (
    id TINYINT UNSIGNED PRIMARY KEY,
    email VARCHAR(254) NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,
    CONSTRAINT single_admin CHECK (id = 1)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await execute(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) PRIMARY KEY,
    csrf_token CHAR(64) NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    INDEX idx_session_expiry (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
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
  const [companyUrlColumn] = await rows<{ total: number }>(`SELECT COUNT(*) AS total
    FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'testimonials' AND column_name = 'company_url'`);
  if (!companyUrlColumn.total) {
    await execute("ALTER TABLE testimonials ADD COLUMN company_url VARCHAR(500) NOT NULL DEFAULT '' AFTER company");
  }
}
