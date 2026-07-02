import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const sql = fs.readFileSync(path.resolve('drizzle/0000_clear_gateway.sql'), 'utf8').replaceAll('--> statement-breakpoint', '');
const client = new PGlite('./.local/pglite-test2');
try {
  await client.exec(sql);
  console.log('success');
} catch (err) {
  console.error(err);
  process.exit(1);
} finally {
  await client.close();
}
