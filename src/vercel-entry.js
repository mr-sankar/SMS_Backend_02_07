import app from "./app.js";
import { ensureDemoUsers } from "./routes/auth.js";
import { ensureStaffAndClassesSeeded } from "./lib/seed-classes.js";
import { ensureStaffIds } from "./routes/staff.js";
import { ensureStudentLinks } from "./lib/seed-students.js";
import { ensureHostelSeedData } from "./lib/seed-hostel.js";
import { ensureDemoNotificationData } from "./lib/seed-demo-data.js";
import { logger } from "./lib/logger.js";

const seedPromise = (async () => {
  try {
    await ensureDemoUsers();
    await ensureStaffAndClassesSeeded();
    await ensureStaffIds();
    await ensureStudentLinks();
    await ensureHostelSeedData();
    await ensureDemoNotificationData();
    logger.info("Demo data seeding completed");
  } catch (err) {
    logger.warn({ err }, "Startup seeding failed (non-fatal)");
  }
})();

export default async function handler(req, res) {
  await seedPromise;
  return app(req, res);
}
