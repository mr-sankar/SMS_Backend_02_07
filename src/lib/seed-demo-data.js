import { db } from "@workspace/db";
import { announcementsTable, leaveRequestsTable, complaintsTable, admissionsTable, usersTable, } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
export async function ensureDemoNotificationData() {
    const [{ count: annCount }] = await db
        .select({ count: sql `count(*)` })
        .from(announcementsTable);
    if (Number(annCount) === 0) {
        const [admin] = await db.select().from(usersTable).where(eq(usersTable.role, "admin"));
        if (admin) {
            await db.insert(announcementsTable).values([
                {
                    title: "Welcome to Nexus Academy — New Term Begins",
                    content: "The new academic term has officially started. All students and staff are requested to check their timetables and report to respective classes.",
                    audience: "all",
                    priority: "normal",
                    authorId: admin.id,
                },
                {
                    title: "Annual Sports Day — 15th June",
                    content: "Annual Sports Day will be held on June 15th. All students are encouraged to participate. Registration forms available at the Sports Office.",
                    audience: "all",
                    priority: "normal",
                    authorId: admin.id,
                },
                {
                    title: "Fee Payment Deadline — End of Month",
                    content: "Reminder: All outstanding fees must be paid by the end of this month. Late payments will attract a penalty. Contact the accounts office for details.",
                    audience: "all",
                    priority: "urgent",
                    authorId: admin.id,
                },
            ]);
            logger.info("Demo announcements seeded");
        }
    }
    const [{ count: leaveCount }] = await db
        .select({ count: sql `count(*)` })
        .from(leaveRequestsTable);
    if (Number(leaveCount) === 0) {
        const [student] = await db.select().from(usersTable).where(eq(usersTable.role, "student"));
        const [teacher] = await db.select().from(usersTable).where(eq(usersTable.role, "teacher"));
        const today = new Date().toISOString().split("T")[0];
        const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];
        if (student) {
            await db.insert(leaveRequestsTable).values({
                applicantId: student.id,
                applicantType: "student",
                leaveType: "sick",
                startDate: today,
                endDate: nextWeek,
                reason: "Fever and medical rest advised by doctor.",
                status: "pending",
            });
        }
        if (teacher) {
            await db.insert(leaveRequestsTable).values({
                applicantId: teacher.id,
                applicantType: "staff",
                leaveType: "personal",
                startDate: today,
                endDate: today,
                reason: "Personal family matter.",
                status: "pending",
            });
        }
        logger.info("Demo leave requests seeded");
    }
    const [{ count: complaintCount }] = await db
        .select({ count: sql `count(*)` })
        .from(complaintsTable);
    if (Number(complaintCount) === 0) {
        const [student] = await db.select().from(usersTable).where(eq(usersTable.role, "student"));
        if (student) {
            await db.insert(complaintsTable).values([
                {
                    title: "Classroom AC Not Working",
                    description: "The air conditioning unit in Room 204 has not been functioning for the past week. The heat is making it difficult to concentrate.",
                    category: "infrastructure",
                    submittedById: student.id,
                    status: "open",
                    priority: "medium",
                },
                {
                    title: "Library Books — Outdated Edition",
                    description: "The physics textbooks in the library are from 2018 and do not cover the updated curriculum. Requesting newer editions.",
                    category: "academic",
                    submittedById: student.id,
                    status: "open",
                    priority: "low",
                },
            ]);
            logger.info("Demo complaints seeded");
        }
    }
    const [{ count: admissionCount }] = await db
        .select({ count: sql `count(*)` })
        .from(admissionsTable);
    if (Number(admissionCount) === 0) {
        await db.insert(admissionsTable).values([
            {
                applicantName: "Arjun Mehta",
                dateOfBirth: "2010-03-15",
                gender: "male",
                applyingForClass: "Class 8",
                previousSchool: "Sunrise Public School",
                parentName: "Rajesh Mehta",
                parentEmail: "rajesh.mehta@email.com",
                parentPhone: "+91-9876543210",
                address: "42 Park Street, Bangalore",
                status: "pending",
            },
            {
                applicantName: "Priya Sharma",
                dateOfBirth: "2011-07-22",
                gender: "female",
                applyingForClass: "Class 7",
                previousSchool: "Green Valley School",
                parentName: "Anita Sharma",
                parentEmail: "anita.sharma@email.com",
                parentPhone: "+91-9765432109",
                address: "15 MG Road, Pune",
                status: "pending",
            },
        ]);
        logger.info("Demo admissions seeded");
    }
}
