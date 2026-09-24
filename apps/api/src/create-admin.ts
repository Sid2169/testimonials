// One-shot CLI: create (or --reset) the single admin account.
// Run via `npm run admin:create`. Passwords are typed invisibly, hashed with
// bcrypt (cost 12), and NEVER logged or stored in plain text. Only one admin
// can ever exist (the schema enforces id = 1).

import bcrypt from 'bcryptjs';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { z } from 'zod';
import { rows, pool, migrate } from './db.js';

// The readline machinery below lets us hide the typed password on screen:
// `muted` toggles whether output actually reaches the console, so while the
// prompt is active the echoed characters are suppressed (a raw prompt without
// output would still accept input, but visibly).
let muted = false;
const output = new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
const input = createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
try {
  await migrate();
  const exists = (await rows('SELECT id FROM admins WHERE id = 1')).length > 0;
  // Refuse to silently overwrite an existing account; --reset is the explicit
  // opt-in (it replaces credentials AND revokes all sessions below).
  if (exists && !process.argv.includes('--reset')) throw new Error('An admin already exists. Use --reset to replace credentials and revoke all sessions.');
  const email = z.email().max(254).parse((await input.question('Admin email: ')).trim().toLowerCase());
  process.stdout.write('Password (12–72 UTF-8 bytes; hidden): ');
  muted = true;
  const password = await input.question('');
  process.stdout.write('\nConfirm password: ');
  const confirmation = await input.question('');
  muted = false;
  process.stdout.write('\n');
  // Length is measured in bytes (bcrypt's 72-byte limit), not characters.
  if (Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 72 || password !== confirmation) throw new Error('Passwords must match and be 12–72 UTF-8 bytes long.');
  const hash = await bcrypt.hash(password, 12);
  const connection = await pool.getConnection();
  try {
    // Write the credential and clear sessions atomically: either both happen
    // (new password + nothing logged in) or neither.
    await connection.beginTransaction();
    await connection.execute('INSERT INTO admins (id, email, password_hash) VALUES (1, ?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email), password_hash = VALUES(password_hash)', [email, hash]);
    await connection.execute('DELETE FROM sessions');
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  console.log('Admin credentials saved.');
} catch (error) {
  // Only the message reaches the user — never a stack trace or credentials.
  console.error(error instanceof Error ? error.message : 'Could not create admin.');
  process.exitCode = 1;
} finally { input.close(); await pool.end(); }