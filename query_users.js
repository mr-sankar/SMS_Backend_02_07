import pg from 'pg';
const { Client } = pg;
const connectionString = "postgresql://neondb_owner:npg_g1kEUNCuOv7j@ep-old-meadow-atl9zdda.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require";
async function main() {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const users = await client.query("SELECT id, username, role, name FROM users");
    console.log("=== USERS ===");
    console.table(users.rows);
  } catch (err) {
    console.error("Error query:", err);
  } finally {
    await client.end();
  }
}
main();