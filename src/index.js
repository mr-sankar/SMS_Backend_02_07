import app from "./app";
import { db } from "@workspace/db";
import { logger } from "./lib/logger";
import { ensureDemoUsers } from "./routes/auth";
import { ensureStaffAndClassesSeeded } from "./lib/seed-classes";
import { ensureStaffIds } from "./routes/staff";
import { ensureStudentLinks } from "./lib/seed-students";
import { ensureHostelSeedData } from "./lib/seed-hostel";
import { ensureDemoNotificationData } from "./lib/seed-demo-data";
import { ensureStudentDocumentDataUrls } from "./routes/students";



const rawPort = process.env["PORT"] || "8081";

async function ensureStaffCheckinsTable() {
    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS staff_checkins (
      id serial primary key,
      user_id integer not null,
      date date not null,
      check_in_time timestamp,
      check_out_time timestamp,
      check_in_reason text,
      check_out_reason text,
      created_at timestamp default now() not null,
      CONSTRAINT staff_checkins_user_date_uniq UNIQUE (user_id, date)
    )`);
        logger.info("Ensured staff_checkins table exists");
    } catch (err) {
        logger.error({ err }, "Failed to ensure staff_checkins table");
        throw err;
    }
}

const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
}
// Ensure all demo users exist before starting
ensureDemoUsers()
    .then(() => {
        logger.info("Demo users verified");
        return ensureStaffAndClassesSeeded();
    })
    .then(() => {
        logger.info("Staff and classes seeded");
        return ensureStaffIds();
    })
    .then(() => {
        logger.info("Staff IDs backfilled");
        return ensureStudentLinks();
    })
    .then(() => {
        logger.info("Student links verified");
        return ensureStudentDocumentDataUrls();
    })
    .then((updatedCount) => {
        logger.info({ updatedCount }, "Student document DB backfill verified");
        return ensureHostelSeedData();
    })
    .then(() => {
        logger.info("Hostel seed data verified");
        return ensureDemoNotificationData();
    })
    .then(async () => {
        logger.info("Demo notification data verified");
        await ensureStaffCheckinsTable();
        app.listen(port, (err) => {
            if (err) {
                logger.error({ err }, "Error listening on port");
                process.exit(1);
            }
            logger.info({ port }, "Server listening");
        });
    })
    .catch(async (err) => {
        logger.warn({ err }, "Startup seeding failed (non-fatal)");
        try {
            await ensureStaffCheckinsTable();
        } catch (e) {
            logger.warn({ err: e }, "Continuing despite failure to ensure staff_checkins table");
        }
        app.listen(port, (err) => {
            if (err) {
                logger.error({ err }, "Error listening on port");
                process.exit(1);
            }
            logger.info({ port }, "Server listening");
        });
    });