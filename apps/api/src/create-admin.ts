import bcrypt from 'bcryptjs';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { z } from 'zod';
import { rows, pool, migrate } from './db.js';

let muted = false;
const output = new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
const input = createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
try {
  await migrate();
  const exists = (await rows('SELECT id FROM admins WHERE id = 1')).length > 0;
  if (exists && !process.argv.includes('--reset')) throw new Error('An admin already exists. Use --reset to replace credentials and revoke all sessions.');
  const email = z.email().max(254).parse((await input.question('Admin email: ')).trim().toLowerCase());
  process.stdout.write('Password (12–72 UTF-8 bytes; hidden): ');
  muted = true;
  const password = await input.question('');
  process.stdout.write('\nConfirm password: ');
  const confirmation = await input.question('');
  muted = false;
  process.stdout.write('\n');
  if (Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 72 || password !== confirmation) throw new Error('Passwords must match and be 12–72 UTF-8 bytes long.');
  const hash = await bcrypt.hash(password, 12);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('INSERT INTO admins (id, email, password_hash) VALUES (1, ?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email), password_hash = VALUES(password_hash)', [email, hash]);
    await connection.execute('DELETE FROM sessions');
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  console.log('Admin credentials saved.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Could not create admin.');
  process.exitCode = 1;
} finally { input.close(); await pool.end(); }
