import pg from "pg";
const { Client } = pg;

const connectionString = "postgresql://neondb_owner:npg_XKO5CwRjAgT6@ep-jolly-breeze-apns8w4b-pooler.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

async function main() {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const users = await client.query("SELECT id, username, role, name, phone FROM users LIMIT 30");
    console.log("=== USERS ===");
    console.table(users.rows);

    const students = await client.query("SELECT id, name, roll_number, user_id, parent_name, parent_phone FROM students LIMIT 30");
    console.log("=== STUDENTS ===");
    console.table(students.rows);

    const staff = await client.query("SELECT id, name, staff_id, role, user_id FROM staff LIMIT 30");
    console.log("=== STAFF ===");
    console.table(staff.rows);

    const leaves = await client.query("SELECT id, applicant_id, applicant_type, leave_type, reason, status FROM leave_requests LIMIT 30");
    console.log("=== LEAVE REQUESTS ===");
    console.table(leaves.rows);

    const results = await client.query("SELECT id, exam_id, student_id, subject_id, marks_obtained FROM exam_results LIMIT 30");
    console.log("=== EXAM RESULTS ===");
    console.table(results.rows);
  } catch (err) {
    console.error("Error inspecting database:", err);
  } finally {
    await client.end();
  }
}

main();
