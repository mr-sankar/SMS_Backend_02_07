import { Router } from "express";
import { db } from "@workspace/db";
import { classesTable, staffTable, studentsTable, subjectsTable, timetableSlotsTable, examsTable, feeStructuresTable, attendanceTable, announcementsTable, assignmentsTable, lessonPlansTable, studyMaterialsTable, } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { CreateClassBody, UpdateClassBody } from "@workspace/api-zod";
import { requireRole } from "../middlewares/auth";

import { resolveOwnClassIds, resolveTeacherClassIds } from "../lib/scope";

import { formatClassName } from "../lib/class-format";
const router = Router();

const READ_CLASSES = ["admin", "teacher", "student", "parent", "clerk", "librarian", "hostel_warden", "transport_manager", "accountant", "driver"];


const WRITE_CLASSES = ["admin"];
router.get("/classes", requireRole(...READ_CLASSES), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        let classes = await db.select().from(classesTable);
        
        if (me.role === "student" || me.role === "parent") {
            const ownClassIds = new Set(await resolveOwnClassIds(me));
            classes = classes.filter((c) => ownClassIds.has(c.id));
        }
        if (me.role === "teacher") {
            const teacherClassIds = new Set(await resolveTeacherClassIds(me.id));
            classes = classes.filter((c) => teacherClassIds.has(c.id));
        }
        
        const staffMembers = await db.select().from(staffTable);
       
        // const staffMembers = await db.select().from(staffTable);
        const students = await db.select().from(studentsTable);
        const staffMap = Object.fromEntries(staffMembers.map((s) => [s.id, s.name]));
        const studentCountMap = {};
        for (const s of students) {
            studentCountMap[s.classId] = (studentCountMap[s.classId] ?? 0) + 1;
        }
        return res.json(classes.map((c) => ({
            ...c,
            name: formatClassName(c),
            teacherName: c.teacherId ? (staffMap[c.teacherId] ?? null) : null,
            studentCount: studentCountMap[c.id] ?? 0,
        })));
    }
    catch (err) {
        req.log.error({ err }, "List classes error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/classes", requireRole(...WRITE_CLASSES), async (req, res) => {
    try {
        const parsed = CreateClassBody.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: "Validation failed", message: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
        }
        const data = parsed.data;
        if (!data.grade?.trim()) {
            return res.status(400).json({ error: "Grade is required and cannot be empty" });
        }
        if (!data.section?.trim()) {
            return res.status(400).json({ error: "Section is required and cannot be empty" });
        }
        if (!data.academicYear?.trim()) {
            return res.status(400).json({ error: "Academic year is required and cannot be empty" });
        }
        const existingClasses = await db.select().from(classesTable).where(
            and(
                eq(classesTable.grade, data.grade),
                eq(classesTable.section, data.section),
                eq(classesTable.academicYear, data.academicYear)
            )
        );
        if (existingClasses.length > 0) {
            return res.status(409).json({
                message: `Class with that name already exists for the academic year ${data.academicYear}.`,
            });
        }
        if (data.teacherId) {
            const [teacher] = await db.select().from(staffTable).where(eq(staffTable.id, data.teacherId));
            if (!teacher) {
                return res.status(400).json({ error: "Assigned teacher does not exist" });
            }
            if (teacher.role !== "teacher") {
                return res.status(400).json({ error: "Assigned staff member is not a teacher" });
            }
        }
        const [cls] = await db.insert(classesTable).values({
            grade: data.grade,
            section: data.section,
            teacherId: data.teacherId ?? null,
            academicYear: data.academicYear,
            room: data.room ?? null,
        }).returning();
        const staffMembers = cls.teacherId ? await db.select().from(staffTable).where(eq(staffTable.id, cls.teacherId)) : [];
        return res.status(201).json({ ...cls, name: formatClassName(cls), teacherName: staffMembers[0]?.name ?? null, studentCount: 0 });
    }
    catch (err) {
        req.log.error({ err }, "Create class error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.get("/classes/:id", requireRole(...READ_CLASSES), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const id = parseInt(String(req.params.id));
        if (me.role === "student" || me.role === "parent") {
            const ownClassIds = new Set(await resolveOwnClassIds(me));
            if (!ownClassIds.has(id))
                return res.status(403).json({ error: "Forbidden" });
        }
        const all = await db.select().from(classesTable).where(eq(classesTable.id, id));
        const cls = all[0];
        if (!cls)
            return res.status(404).json({ error: "Not found" });
        const staffMembers = cls.teacherId ? await db.select().from(staffTable).where(eq(staffTable.id, cls.teacherId)) : [];
        const students = await db.select().from(studentsTable).where(eq(studentsTable.classId, id));
        return res.json({
            ...cls,
            name: formatClassName(cls),
            teacherName: staffMembers[0]?.name ?? null,
            studentCount: students.length,
        });
    }
    catch (err) {
        req.log.error({ err }, "Get class error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.patch("/classes/:id", requireRole(...WRITE_CLASSES), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        const parsed = UpdateClassBody.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: "Validation failed", message: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
        }
        const data = parsed.data;
        const existing = (await db.select().from(classesTable).where(eq(classesTable.id, id)))[0];
        if (!existing) {
            return res.status(404).json({ error: "Class not found" });
        }
        const grade = data.grade !== undefined ? data.grade : existing.grade;
        const section = data.section !== undefined ? data.section : existing.section;
        const academicYear = data.academicYear !== undefined ? data.academicYear : existing.academicYear;
        if (data.grade !== undefined || data.section !== undefined || data.academicYear !== undefined) {
            const duplicate = await db.select().from(classesTable).where(
                and(
                    eq(classesTable.grade, grade),
                    eq(classesTable.section, section),
                    eq(classesTable.academicYear, academicYear)
                )
            );
            if (duplicate.length > 0 && duplicate[0].id !== id) {
                return res.status(409).json({ error: `Class ${grade}-${section} already exists for academic year ${academicYear}` });
            }
        }
        if (data.teacherId) {
            const [teacher] = await db.select().from(staffTable).where(eq(staffTable.id, data.teacherId));
            if (!teacher) {
                return res.status(400).json({ error: "Assigned teacher does not exist" });
            }
            if (teacher.role !== "teacher") {
                return res.status(400).json({ error: "Assigned staff member is not a teacher" });
            }
        }
        const upd = {};
        if (data.grade !== undefined)
            upd.grade = data.grade;
        if (data.section !== undefined)
            upd.section = data.section;
        if (data.academicYear !== undefined)
            upd.academicYear = data.academicYear;
        if (data.teacherId !== undefined)
            upd.teacherId = data.teacherId;
        if (data.room !== undefined)
            upd.room = data.room;
        const [updated] = await db.update(classesTable).set(upd).where(eq(classesTable.id, id)).returning();
        const staffMembers = updated.teacherId
            ? await db.select().from(staffTable).where(eq(staffTable.id, updated.teacherId))
            : [];
        const students = await db.select().from(studentsTable).where(eq(studentsTable.classId, id));
        return res.json({
            ...updated,
            name: formatClassName(updated),
            teacherName: staffMembers[0]?.name ?? null,
            studentCount: students.length,
        });
    }
    catch (err) {
        req.log.error({ err }, "Update class error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.delete("/classes/:id", requireRole(...WRITE_CLASSES), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        if (Number.isNaN(id))
            return res.status(400).json({ error: "Invalid id" });
        // Reference checks — block delete if anything still depends on this class.
        const checks = [];
        const [students, subjects, timetable, exams, fees, attendance, announcements, assignments, lessonPlans, materials] = await Promise.all([
            db.select({ id: studentsTable.id }).from(studentsTable).where(eq(studentsTable.classId, id)),
            db.select({ id: subjectsTable.id }).from(subjectsTable).where(eq(subjectsTable.classId, id)),
            db.select({ id: timetableSlotsTable.id }).from(timetableSlotsTable).where(eq(timetableSlotsTable.classId, id)),
            db.select({ id: examsTable.id }).from(examsTable).where(eq(examsTable.classId, id)),
            db.select({ id: feeStructuresTable.id }).from(feeStructuresTable).where(eq(feeStructuresTable.classId, id)),
            db.select({ id: attendanceTable.id }).from(attendanceTable).where(eq(attendanceTable.classId, id)),
            db.select({ id: announcementsTable.id }).from(announcementsTable).where(eq(announcementsTable.classId, id)),
            db.select({ id: assignmentsTable.id }).from(assignmentsTable).where(eq(assignmentsTable.classId, id)),
            db.select({ id: lessonPlansTable.id }).from(lessonPlansTable).where(eq(lessonPlansTable.classId, id)),
            db.select({ id: studyMaterialsTable.id }).from(studyMaterialsTable).where(eq(studyMaterialsTable.classId, id)),
        ]);
        if (students.length)
            checks.push({ label: `${students.length} student${students.length > 1 ? "s" : ""}`, count: students.length });
        if (subjects.length)
            checks.push({ label: `${subjects.length} subject${subjects.length > 1 ? "s" : ""}`, count: subjects.length });
        if (timetable.length)
            checks.push({ label: `${timetable.length} timetable slot${timetable.length > 1 ? "s" : ""}`, count: timetable.length });
        if (exams.length)
            checks.push({ label: `${exams.length} exam${exams.length > 1 ? "s" : ""}`, count: exams.length });
        if (fees.length)
            checks.push({ label: `${fees.length} fee structure${fees.length > 1 ? "s" : ""}`, count: fees.length });
        if (attendance.length)
            checks.push({ label: `${attendance.length} attendance record${attendance.length > 1 ? "s" : ""}`, count: attendance.length });
        if (announcements.length)
            checks.push({ label: `${announcements.length} announcement${announcements.length > 1 ? "s" : ""}`, count: announcements.length });
        if (assignments.length)
            checks.push({ label: `${assignments.length} assignment${assignments.length > 1 ? "s" : ""}`, count: assignments.length });
        if (lessonPlans.length)
            checks.push({ label: `${lessonPlans.length} lesson plan${lessonPlans.length > 1 ? "s" : ""}`, count: lessonPlans.length });
        if (materials.length)
            checks.push({ label: `${materials.length} study material${materials.length > 1 ? "s" : ""}`, count: materials.length });
        if (checks.length > 0) {
            return res.status(409).json({
                error: "Cannot delete class",
                message: `This class is referenced by ${checks.map((c) => c.label).join(", ")}. Remove or reassign them first.`,
                references: checks,
            });
        }
        const [deleted] = await db.delete(classesTable).where(eq(classesTable.id, id)).returning();
        if (!deleted)
            return res.status(404).json({ error: "Not found" });
        return res.status(204).send();
    }
    catch (err) {
        req.log.error({ err }, "Delete class error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
export default router;
