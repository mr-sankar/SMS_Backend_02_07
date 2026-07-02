import { db } from "@workspace/db";
import { usersTable, studentsTable, classesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
function getClassLevel(cls) {
    const match = String(cls?.grade ?? "").match(/\d+/);
    return match ? Number(match[0]) : null;
}
function findClassSix(classes) {
    return classes.find((cls) => getClassLevel(cls) === 6) ??
        classes.find((cls) => {
            const level = getClassLevel(cls);
            return level !== null && level >= 6;
        }) ??
        classes[0];
}
/**
 * Ensures that every demo user with role "student" has a linked row in the
 * students table (matched by userId). Without this, student-scoped endpoints
 * like /api/hostel return 403 because resolveStudentForUser() returns null.
 */
export async function ensureStudentLinks() {
    const studentUsers = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.role, "student"));
    if (studentUsers.length === 0)
        return;
    const existingStudents = await db.select().from(studentsTable);
    const allClasses = await db.select().from(classesTable);
    const classSix = findClassSix(allClasses);
    const fallbackClassId = classSix?.id ?? 1;
    for (const user of studentUsers) {
        const linked = existingStudents.find((s) => s.userId === user.id) ||
            (user.email
                ? existingStudents.find((s) => s.email && s.email === user.email)
                : undefined);
        if (linked) {
            const linkedClass = allClasses.find((cls) => cls.id === linked.classId);
            const linkedLevel = getClassLevel(linkedClass);
            if ((linkedLevel === null || linkedLevel < 6) && fallbackClassId) {
                await db
                    .update(studentsTable)
                    .set({ classId: fallbackClassId, parentName: "Vikram Singh", parentPhone: "9998887777" })
                    .where(eq(studentsTable.id, linked.id));
                logger.info({ userId: user.id, classId: fallbackClassId }, "Moved demo student to Class 6+ for period attendance");
            }
            continue;
        }
        // Create a minimal student record linked to this user
        const rollNumber = `DEMO-${user.id}`;
        const existing = await db
            .select()
            .from(studentsTable)
            .where(eq(studentsTable.rollNumber, rollNumber));
        if (existing.length > 0) {
            // Link by userId if not already set
            if (!existing[0].userId || !existing[0].parentPhone) {
                await db
                    .update(studentsTable)
                    .set({ userId: user.id, classId: fallbackClassId, parentName: "Vikram Singh", parentPhone: "9998887777" })
                    .where(eq(studentsTable.rollNumber, rollNumber));
                logger.info({ userId: user.id }, "Linked existing student record to demo user and parent");
            }
            continue;
        }
        await db.insert(studentsTable).values({
            name: user.name ?? user.username,
            rollNumber,
            classId: fallbackClassId,
            gender: "Male",
            admissionDate: new Date().toISOString().split("T")[0],
            email: user.email ?? undefined,
            userId: user.id,
            parentName: "Vikram Singh",
            parentPhone: "9998887777",
            status: "active",
        });
        logger.info({ userId: user.id, name: user.name }, "Created demo student record");
    }
    if (!fallbackClassId)
        return;
    const demoStudents = [
        { name: "Aarav Mehta", rollNumber: "C6-DEMO-01", gender: "Male", parentName: "Neha Mehta", parentPhone: "9998887001" },
        { name: "Isha Rao", rollNumber: "C6-DEMO-02", gender: "Female", parentName: "Suresh Rao", parentPhone: "9998887002" },
        { name: "Kabir Khan", rollNumber: "C6-DEMO-03", gender: "Male", parentName: "Farah Khan", parentPhone: "9998887003" },
        { name: "Meera Nair", rollNumber: "C6-DEMO-04", gender: "Female", parentName: "Anil Nair", parentPhone: "9998887004" },
        { name: "Rohan Das", rollNumber: "C6-DEMO-05", gender: "Male", parentName: "Priya Das", parentPhone: "9998887005" },
    ];
    let createdCount = 0;
    let repairedCount = 0;
    const refreshedStudents = await db.select().from(studentsTable);
    for (const student of demoStudents) {
        const exists = refreshedStudents.find((s) => s.rollNumber === student.rollNumber);
        if (exists) {
            if (exists.parentPhone !== student.parentPhone || exists.parentName !== student.parentName || exists.classId !== fallbackClassId) {
                await db
                    .update(studentsTable)
                    .set({
                    classId: fallbackClassId,
                    parentName: student.parentName,
                    parentPhone: student.parentPhone,
                })
                    .where(eq(studentsTable.rollNumber, student.rollNumber));
                repairedCount++;
            }
            continue;
        }
        await db.insert(studentsTable).values({
            name: student.name,
            rollNumber: student.rollNumber,
            classId: fallbackClassId,
            gender: student.gender,
            admissionDate: new Date().toISOString().split("T")[0],
            parentName: student.parentName,
            parentPhone: student.parentPhone,
            status: "active",
        });
        createdCount++;
    }
    if (createdCount > 0) {
        logger.info({ classId: fallbackClassId, count: createdCount }, "Seeded Class 6 demo students for period attendance");
    }
    if (repairedCount > 0) {
        logger.info({ classId: fallbackClassId, count: repairedCount }, "Repaired Class 6 demo parent links");
    }
}
