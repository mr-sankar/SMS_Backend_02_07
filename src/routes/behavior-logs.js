import { Router } from "express";
import { db } from "@workspace/db";
import { behaviorLogsTable, studentsTable, staffTable, classesTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { requireRole } from "../middlewares/auth";
import { formatClassName } from "../lib/class-format";
const router = Router();
router.get("/behavior-logs", requireRole("admin", "teacher", "student", "parent"), async (req, res) => {
    try {
       const studentId = req.query.studentId ? parseInt(String(req.query.studentId)) : null;
        const classId = req.query.classId ? parseInt(String(req.query.classId)) : null;
        const [logs, students, classes, staff] = await Promise.all([
            db.select().from(behaviorLogsTable).orderBy(desc(behaviorLogsTable.createdAt)),
            db.select().from(studentsTable),
            db.select().from(classesTable),
            db.select().from(staffTable),
        ]);
        const studentMap = new Map(students.map((s) => [s.id, s]));
        const classNameMap = Object.fromEntries(classes.map((c) => [c.id, formatClassName(c)]));
        const staffMap = Object.fromEntries(staff.map((s) => [s.id, s.name]));
        const filteredLogs = logs.filter((log) => {
            const student = studentMap.get(log.studentId);
            const resolvedClassId = log.classId ?? student?.classId ?? null;
            if (studentId && log.studentId !== studentId) {
                return false;
            }
            if (classId && Number(resolvedClassId) !== classId) {
                return false;
            }
            return true;
        });
        return res.json(filteredLogs.map((log) => {
            const student = studentMap.get(log.studentId) ?? null;
            const studentClassId = log.classId ?? student?.classId ?? null;
            return {
                ...log,
                studentName: student?.name ?? null,
                classId: studentClassId,
                className: studentClassId ? (classNameMap[studentClassId] ?? `Class ${studentClassId}`) : null,
                teacherName: log.teacherId ? (staffMap[log.teacherId] ?? null) : null,
            };
        }));
    }
    catch (err) {
        req.log.error({ err }, "List behavior logs error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/behavior-logs", requireRole("admin", "teacher"), async (req, res) => {
    try {
        const { studentId, classId, teacherId, type, category, description, date, points } = req.body;
        if (!studentId || !category || !description || !date) {
            return res.status(400).json({ error: "Missing required fields" });
        }
        const parsedStudentId = parseInt(String(studentId));
        const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, parsedStudentId));
        if (!student) {
            return res.status(404).json({ error: "Student not found" });
        }
        const hasExplicitClassId = classId !== undefined && classId !== null && String(classId).trim() !== "";
        const parsedClassId = hasExplicitClassId ? parseInt(String(classId)) : student.classId;
        if (Number.isNaN(parsedClassId)) {
            return res.status(400).json({ error: "Invalid classId" });
        }
        const [cls] = await db.select().from(classesTable).where(eq(classesTable.id, parsedClassId));
        if (!cls) {
            return res.status(400).json({ error: "Class not found" });
        }
        const [log] = await db
            .insert(behaviorLogsTable)
            .values({
            studentId: parsedStudentId,
            classId: parsedClassId,
            teacherId: teacherId ? parseInt(String(teacherId)) : null,
            type: type ?? "neutral",
            category,
            description,
            date,
            points: points ? parseInt(String(points)) : 0,
        })
            .returning();
        return res.status(201).json(log);
    }
    catch (err) {
        req.log.error({ err }, "Create behavior log error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
export default router;
