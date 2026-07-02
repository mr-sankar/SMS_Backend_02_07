import pg from "pg";
const { Client } = pg;

const connectionString = "postgresql://neondb_owner:npg_XKO5CwRjAgT6@ep-jolly-breeze-apns8w4b-pooler.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

async function main() {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const res = await client.query(`
      INSERT INTO fee_records (student_id, fee_type, amount, due_date, academic_year, status)
      VALUES (-999, 'admission', '5000.00', '2026-06-18', '2026-27', 'pending')
      RETURNING *
    `);
    console.log("Insert success:", res.rows);
    // Delete it after
    await client.query("DELETE FROM fee_records WHERE student_id = -999");
  } catch (err) {
    console.error("Insert failed:", err.message);
  } finally {
    await client.end();
  }
}

main();
