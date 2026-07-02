import { db } from "../db/index.js";
import { usersTable, staffTable, classesTable, subjectsTable } from "../db/index.js";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";

const ROLE_PREFIX = {
    teacher: "TEA",
    admin: "ADM",
    clerk: "CLK",
    accountant: "ACC",
    hostel_warden: "HWN",
    transport_manager: "TRP",
    driver: "DRV",
    store_manager: "STM",
    librarian: "LIB",
};

function prefixFor(role) {
    return ROLE_PREFIX[role] ?? "STF";
}

export async function ensureStaffAndClassesSeeded() {
    try {
        // Seed staff rows for demo users with staff roles
        const staffRoles = Object.keys(ROLE_PREFIX);
        const allUsers = await db.select().from(usersTable);
        const usersToCreateStaffFor = allUsers.filter(u => staffRoles.includes(u.role));

        const existingStaff = await db.select().from(staffTable);
        const year = new Date().getFullYear();

        let createdStaffCount = 0;
        let teacherId = null;

        for (const user of usersToCreateStaffFor) {
            const hasStaffRow = existingStaff.some(s => s.userId === user.id || s.email === user.email);
            if (hasStaffRow) {
                if (user.role === "teacher") {
                    const row = existingStaff.find(s => s.userId === user.id || s.email === user.email);
                    teacherId = row?.id;
                }
                continue;
            }

            const prefix = `${prefixFor(user.role)}${year}`;
            const seq = existingStaff.filter(s => s.staffId && s.staffId.startsWith(prefix)).length + 1;
            const staffIdStr = `${prefix}${String(seq).padStart(3, "0")}`;

            const [newStaff] = await db.insert(staffTable).values({
                staffId: staffIdStr,
                name: user.name ?? user.username,
                role: user.role,
                department: user.role === "teacher" ? "Science" : "Administration",
                email: user.email,
                phone: user.phone ?? "9999999999",
                qualification: user.role === "teacher" ? "B.Ed, M.Sc" : "Graduate",
                salary: "35000.00",
                yearsOfExperience: 5,
                joinDate: new Date().toISOString().split("T")[0],
                status: "active",
                userId: user.id,
            }).returning();

            if (user.role === "teacher") {
                teacherId = newStaff.id;
            }
            createdStaffCount++;
        }

        if (createdStaffCount > 0) {
            logger.info(`Seeded ${createdStaffCount} staff records for demo users`);
        }

        // 2. Seed default classes. Older local databases may already have
        // Class 1-5, so fill any missing demo classes instead of only seeding
        // when the table is empty.
    } catch (err) {
        logger.error({ err }, "Error during staff and classes seeding");
    }
}
