import { Router } from "express";
import { db } from "@workspace/db";
import { examsTable, examResultsTable, classesTable, studentsTable, subjectsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { requireRole } from "../middlewares/auth";
import { resolveOwnClassIds, resolveOwnStudentIds } from "../lib/scope";
const router = Router();
const READ_EXAM = ["admin", "teacher", "student", "parent", "clerk"];
const MANAGE_EXAM = ["admin"];
const WRITE_EXAM_RESULT = ["admin", "teacher"];
function normalizeScheduleValue(value) {
    return value === undefined || value === null ? "" : String(value).trim().toLowerCase();
}
function isDuplicateExamSchedule(existing, data) {
    return normalizeScheduleValue(existing.name) === normalizeScheduleValue(data.name) &&
        normalizeScheduleValue(existing.type) === normalizeScheduleValue(data.type) &&
        Number(existing.classId) === Number(data.classId) &&
        normalizeScheduleValue(existing.startDate) === normalizeScheduleValue(data.startDate) &&
        normalizeScheduleValue(existing.endDate) === normalizeScheduleValue(data.endDate || data.startDate) &&
        normalizeScheduleValue(existing.startTime) === normalizeScheduleValue(data.startTime) &&
        normalizeScheduleValue(existing.endTime) === normalizeScheduleValue(data.endTime) &&
        normalizeScheduleValue(existing.room) === normalizeScheduleValue(data.room);
}
function isFailingResult(result, exam) {
    const marks = Number(result.marksObtained);
    const passingMarks = Number(exam?.passingMarks ?? 0);
    return result.grade === "F" || (Number.isFinite(passingMarks) && passingMarks > 0 && marks < passingMarks);
}
router.get("/exams", requireRole(...READ_EXAM), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        let all = await db
            .select()
            .from(examsTable)
            .orderBy(desc(examsTable.createdAt), desc(examsTable.id));
        const classes = await db.select().from(classesTable);
        const classMap = Object.fromEntries(classes.map((c) => [c.id, `${c.grade}-${c.section}`]));
        // Student/parent: only exams for their (children's) classes
        if (me.role === "student" || me.role === "parent") {
            const classIds = new Set(await resolveOwnClassIds(me));
            all = all.filter((e) => classIds.has(e.classId));
        } else if (me.role === "teacher") {
            const { resolveTeacherClassIds } = await import("../lib/scope");
            const classIds = new Set(await resolveTeacherClassIds(me.id));
            all = all.filter((e) => classIds.has(e.classId));
        }
        return res.json(all.map((e) => ({ ...e, className: classMap[e.classId] ?? `Class ${e.classId}` })));
    }
    catch (err) {
        req.log.error({ err }, "List exams error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/exams", requireRole(...MANAGE_EXAM), async (req, res) => {
    try {
        const data = req.body;
        const isSupply = Boolean(data.isSupply);
        let originalExam = null;
        if (isSupply) {
            const originalExamId = parseInt(String(data.originalExamId));
            if (!originalExamId) {
                return res.status(400).json({ error: "Original exam required" });
            }
            const [foundOriginal] = await db.select().from(examsTable).where(eq(examsTable.id, originalExamId));
            if (!foundOriginal) {
                return res.status(404).json({ error: "Original exam not found" });
            }
            if (foundOriginal.status !== "completed") {
                return res.status(400).json({ error: "Supply exams can only be scheduled for completed exams" });
            }
            originalExam = foundOriginal;
            data.name = data.name || `${foundOriginal.name} Supply`;
            data.type = foundOriginal.type;
            data.classId = foundOriginal.classId;
            data.maxMarks = data.maxMarks ?? foundOriginal.maxMarks;
            data.passingMarks = data.passingMarks ?? foundOriginal.passingMarks;
        }
        const existingClassExams = await db.select().from(examsTable).where(eq(examsTable.classId, Number(data.classId)));
        // ── Block if another active exam already exists on same date for this class ──
        const activeStatuses = ["upcoming", "ongoing"];
        const dateOverlap = existingClassExams.some((exam) =>
            activeStatuses.includes(exam.status) &&
            exam.startDate === data.startDate
        );
        if (dateOverlap) {
            return res.status(409).json({ error: "Date unavailable", details: "An exam is already scheduled on this date for the selected class." });
        }
        if (existingClassExams.some((exam) => isDuplicateExamSchedule(exam, data))) {
            return res.status(409).json({ error: "Duplicate exam schedule", details: "An exam already exists with the same exam name, type, class, dates, times, and assigned room." });
        }
        const [exam] = await db.insert(examsTable).values({
            name: data.name,
            type: data.type,
            classId: data.classId,
            startDate: data.startDate,
            endDate: data.endDate,
            maxMarks: data.maxMarks ?? null,
            passingMarks: data.passingMarks ?? null,
            status: "upcoming",
            startTime: data.startTime ?? null,
            endTime: data.endTime ?? null,
            room: data.room ?? null,
            isSupply,
            originalExamId: originalExam?.id ?? null,
        }).returning();
        const classes = await db.select().from(classesTable).where(eq(classesTable.id, exam.classId));
        const cls = classes[0];
        return res.status(201).json({ ...exam, className: cls ? `${cls.grade}-${cls.section}` : `Class ${exam.classId}` });
    }
    catch (err) {
        req.log.error({ err }, "Create exam error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.get("/exams/:id", requireRole(...READ_EXAM), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const all = await db.select().from(examsTable).where(eq(examsTable.id, parseInt(String(req.params.id))));
        if (!all[0])
            return res.status(404).json({ error: "Not found" });
        const exam = all[0];
        if (me.role === "student" || me.role === "parent") {
            const classIds = new Set(await resolveOwnClassIds(me));
            if (!classIds.has(exam.classId))
                return res.status(403).json({ error: "Forbidden" });
        }
        const classes = await db.select().from(classesTable).where(eq(classesTable.id, exam.classId));
        const cls = classes[0];
        return res.json({ ...exam, className: cls ? `${cls.grade}-${cls.section}` : `Class ${exam.classId}` });
    }
    catch (err) {
        req.log.error({ err }, "Get exam error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.patch("/exams/:id", requireRole(...MANAGE_EXAM), async (req, res) => {
    try {
        const data = req.body;
        const upd = {};
        if (data.name !== undefined)
            upd.name = data.name;
        if (data.startDate !== undefined)
            upd.startDate = data.startDate;
        if (data.endDate !== undefined)
            upd.endDate = data.endDate;
        if (data.status !== undefined)
            upd.status = data.status;
        if (data.startTime !== undefined)
            upd.startTime = data.startTime;
        if (data.endTime !== undefined)
            upd.endTime = data.endTime;
        if (data.room !== undefined)
            upd.room = data.room;
        const [updated] = await db.update(examsTable).set(upd).where(eq(examsTable.id, parseInt(String(req.params.id)))).returning();
        if (!updated)
            return res.status(404).json({ error: "Not found" });
        const classes = await db.select().from(classesTable).where(eq(classesTable.id, updated.classId));
        const cls = classes[0];
        return res.json({ ...updated, className: cls ? `${cls.grade}-${cls.section}` : `Class ${updated.classId}` });
    }
    catch (err) {
        req.log.error({ err }, "Update exam error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
function calcGrade(marks, max) {
    const pct = (marks / max) * 100;
    if (pct >= 90)
        return "A+";
    if (pct >= 80)
        return "A";
    if (pct >= 70)
        return "B+";
    if (pct >= 60)
        return "B";
    if (pct >= 50)
        return "C";
    if (pct >= 40)
        return "D";
    return "F";
}
router.get("/exam-results", requireRole(...READ_EXAM), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const { examId, studentId, classId } = req.query;
        const students = await db.select().from(studentsTable);
        const subjects = await db.select().from(subjectsTable);
        const exams = await db.select().from(examsTable);
        const classRows = await db.select().from(classesTable);
        const classMap = Object.fromEntries(classRows.map((c) => [c.id, {
            name: `${c.grade}-${c.section}`,
            academicYear: c.academicYear,
        }]));
        const studentMap = Object.fromEntries(students.map((s) => {
            const cls = classMap[s.classId];
            return [s.id, {
                name: s.name,
                avatarUrl: s.avatarUrl,
                rollNumber: s.rollNumber,
                classId: s.classId,
                className: cls?.name ?? `Class ${s.classId}`,
                academicYear: cls?.academicYear ?? null,
            }];
        }));
        const subjectMap = Object.fromEntries(subjects.map((s) => [s.id, s.name]));
        const examMap = Object.fromEntries(exams.map((e) => [e.id, {
            name: e.name,
            classId: e.classId,
            className: classMap[e.classId]?.name ?? `Class ${e.classId}`,
            academicYear: classMap[e.classId]?.academicYear ?? null,
        }]));
        let all = await db
            .select()
            .from(examResultsTable)
            .orderBy(desc(examResultsTable.createdAt), desc(examResultsTable.id));
        // ── SCOPING: student/parent only own/children results ──
        if (me.role === "student" || me.role === "parent") {
            const ownIds = new Set(await resolveOwnStudentIds(me));
            if (studentId) {
                const sid = parseInt(String(studentId));
                if (!ownIds.has(sid))
                    return res.status(403).json({ error: "Forbidden" });
            }
            all = all.filter((r) => ownIds.has(r.studentId));
        }
        // Out-of-scope classId guard for student/parent
        if ((me.role === "student" || me.role === "parent") && classId) {
            const { resolveOwnClassIds: rocl } = await import("../lib/scope");
            const ownClassIds = new Set(await rocl(me));
            if (!ownClassIds.has(parseInt(String(classId))))
                return res.status(403).json({ error: "Forbidden" });
        }
        if (me.role === "teacher") {
            const { resolveTeacherClassIds } = await import("../lib/scope");
            const classIds = new Set(await resolveTeacherClassIds(me.id));
            if (classId && !classIds.has(parseInt(String(classId))))
                return res.status(403).json({ error: "Forbidden", details: "Teacher not associated with this class" });
            const studentObjects = Object.fromEntries(students.map((s) => [s.id, s]));
            all = all.filter((r) => {
                const s = studentObjects[r.studentId];
                return s && classIds.has(s.classId);
            });
        }
        if (examId)
            all = all.filter((r) => r.examId === parseInt(String(examId)));
        if (studentId)
            all = all.filter((r) => r.studentId === parseInt(String(studentId)));
        if (classId) {
            const classStudents = students.filter((s) => s.classId === parseInt(String(classId))).map((s) => s.id);
            all = all.filter((r) => classStudents.includes(r.studentId));
        }
        return res.json(all.map((r) => ({
            ...r,
            marksObtained: Number(r.marksObtained),
            maxMarks: Number(r.maxMarks),
            gpa: r.gpa ? Number(r.gpa) : null,
            examName: examMap[r.examId]?.name ?? `Exam ${r.examId}`,
            className: examMap[r.examId]?.className ?? studentMap[r.studentId]?.className ?? null,
            academicYear: examMap[r.examId]?.academicYear ?? studentMap[r.studentId]?.academicYear ?? null,
            studentName: studentMap[r.studentId]?.name ?? `Student ${r.studentId}`,
            studentRollNumber: studentMap[r.studentId]?.rollNumber ?? null,
            studentClassName: studentMap[r.studentId]?.className ?? null,
            studentAcademicYear: studentMap[r.studentId]?.academicYear ?? null,
            studentAvatarUrl: studentMap[r.studentId]?.avatarUrl ?? null,
            subjectName: subjectMap[r.subjectId] ?? `Subject ${r.subjectId}`,
            grade: r.grade || calcGrade(Number(r.marksObtained), Number(r.maxMarks)),
        })));
    }
    catch (err) {
        req.log.error({ err }, "List exam results error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/exam-results", requireRole(...WRITE_EXAM_RESULT), async (req, res) => {
    try {
        const data = req.body;
        const [exam] = await db.select().from(examsTable).where(eq(examsTable.id, data.examId));
        if (!exam) {
            return res.status(404).json({ error: "Exam not found" });
        }
        if (req.user?.role === "teacher") {
            const { resolveTeacherClassIds } = await import("../lib/scope");
            const classIds = await resolveTeacherClassIds(req.user.id);
            const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, data.studentId));
            if (!student || !classIds.includes(student.classId))
                return res.status(403).json({ error: "Forbidden", details: "Teachers can only submit exam results for their assigned classes" });
        }
        let originalResult = null;
        if (exam.isSupply && exam.originalExamId) {
            const [originalExam] = await db.select().from(examsTable).where(eq(examsTable.id, exam.originalExamId));
            const originalResults = await db.select().from(examResultsTable).where(eq(examResultsTable.examId, exam.originalExamId));
            originalResult = originalResults.find((result) => Number(result.studentId) === Number(data.studentId) && Number(result.subjectId) === Number(data.subjectId));
            if (!originalResult || !isFailingResult(originalResult, originalExam)) {
                return res.status(400).json({ error: "Not eligible", details: "Supply exam results can only be entered for students who failed the original exam subject." });
            }
        }
        const grade = calcGrade(data.marksObtained, data.maxMarks);
        const [result] = await db.insert(examResultsTable).values({
            examId: data.examId,
            studentId: data.studentId,
            subjectId: data.subjectId,
            marksObtained: String(data.marksObtained),
            maxMarks: String(data.maxMarks),
            grade,
            remarks: data.remarks ?? null,
            isSupplementary: Boolean(exam.isSupply),
            originalMarks: originalResult ? String(originalResult.marksObtained) : null,
        }).returning();
        return res.status(201).json({
            ...result,
            marksObtained: Number(result.marksObtained),
            maxMarks: Number(result.maxMarks),
            gpa: null,
            examName: `Exam ${result.examId}`,
            studentName: `Student ${result.studentId}`,
            subjectName: `Subject ${result.subjectId}`,
        });
    }
    catch (err) {
        req.log.error({ err }, "Create exam result error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.patch("/exam-results/:id", requireRole(...WRITE_EXAM_RESULT), async (req, res) => {
    try {
        const data = req.body;
        if (req.user?.role === "teacher") {
            const { resolveTeacherClassIds } = await import("../lib/scope");
            const classIds = await resolveTeacherClassIds(req.user.id);
            const [result] = await db.select().from(examResultsTable).where(eq(examResultsTable.id, parseInt(String(req.params.id))));
            if (!result) return res.status(404).json({ error: "Not found" });
            const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, result.studentId));
            if (!student || !classIds.includes(student.classId))
                return res.status(403).json({ error: "Forbidden", details: "Teachers can only modify exam results for their assigned classes" });
        }
        const upd = {};
        if (data.marksObtained !== undefined)
            upd.marksObtained = String(data.marksObtained);
        if (data.remarks !== undefined)
            upd.remarks = data.remarks;
        const [updated] = await db.update(examResultsTable).set(upd).where(eq(examResultsTable.id, parseInt(String(req.params.id)))).returning();
        if (!updated)
            return res.status(404).json({ error: "Not found" });
        return res.json({
            ...updated,
            marksObtained: Number(updated.marksObtained),
            maxMarks: Number(updated.maxMarks),
            gpa: updated.gpa ? Number(updated.gpa) : null,
            examName: `Exam ${updated.examId}`,
            studentName: `Student ${updated.studentId}`,
            subjectName: `Subject ${updated.subjectId}`,
        });
    }
    catch (err) {
        req.log.error({ err }, "Update exam result error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/exam-results/:id/supplementary", requireRole("admin", "teacher"), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        const { marksObtained, remarks } = req.body;
        const [result] = await db.select().from(examResultsTable).where(eq(examResultsTable.id, id));
        if (!result) return res.status(404).json({ error: "Not found" });
        if (req.user?.role === "teacher") {
            const { resolveTeacherClassIds } = await import("../lib/scope");
            const classIds = await resolveTeacherClassIds(req.user.id);
            const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, result.studentId));
            if (!student || !classIds.includes(student.classId)) {
                return res.status(403).json({ error: "Forbidden", details: "Teachers can only modify exam results for their assigned classes" });
            }
        }
        const originalMarks = result.originalMarks || result.marksObtained;
        const maxMarksNum = Number(result.maxMarks);
        const marksObtainedNum = Number(marksObtained);
        const grade = calcGrade(marksObtainedNum, maxMarksNum);
        const [updated] = await db.update(examResultsTable).set({
            marksObtained: String(marksObtained),
            grade,
            isSupplementary: true,
            originalMarks: String(originalMarks),
            remarks: remarks ?? result.remarks ?? "Supplementary Exam"
        }).where(eq(examResultsTable.id, id)).returning();
        return res.json({
            ...updated,
            marksObtained: Number(updated.marksObtained),
            maxMarks: Number(updated.maxMarks),
            originalMarks: Number(updated.originalMarks),
            gpa: updated.gpa ? Number(updated.gpa) : null,
            examName: `Exam ${updated.examId}`,
            studentName: `Student ${updated.studentId}`,
            subjectName: `Subject ${updated.subjectId}`,
        });
    } catch (err) {
        req.log.error({ err }, "Supplementary exam result update error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
function gradeToGpaPoint(grade) {
    switch (grade) {
        case "A+": return 10;
        case "A": return 9;
        case "B+": return 8;
        case "B": return 7;
        case "C": return 6;
        case "D": return 5;
        default: return 0;
    }
}
router.get("/exam-results/student/:studentId/gpa", requireRole("admin", "teacher", "student", "parent", "clerk"), async (req, res) => {
    try {
        const studentId = parseInt(String(req.params.studentId));
        if (req.user?.role === "student" || req.user?.role === "parent") {
            const { resolveOwnStudentIds } = await import("../lib/scope");
            const ownIds = new Set(await resolveOwnStudentIds(req.user));
            if (!ownIds.has(studentId)) {
                return res.status(403).json({ error: "Forbidden" });
            }
        } else if (req.user?.role === "teacher") {
            const { resolveTeacherClassIds } = await import("../lib/scope");
            const classIds = await resolveTeacherClassIds(req.user.id);
            const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, studentId));
            if (!student || !classIds.includes(student.classId)) {
                return res.status(403).json({ error: "Forbidden", details: "Teacher not associated with this student's class" });
            }
        }
        const { examId } = req.query;
        const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, studentId));
        if (!student)
            return res.status(404).json({ error: "Student not found" });
        const allResults = await db.select().from(examResultsTable);
        let results = allResults.filter(r => Number(r.studentId) === Number(studentId));
        if (examId) {
            results = results.filter(r => Number(r.examId) === Number(examId));
        }
        const subjects = await db.select().from(subjectsTable);
        const exams = await db.select().from(examsTable);
        const classes = await db.select().from(classesTable);
        const subjectMap = Object.fromEntries(subjects.map(s => [s.id, s]));
        const classMap = Object.fromEntries(classes.map((c) => [c.id, {
            name: `${c.grade}-${c.section}`,
            academicYear: c.academicYear,
        }]));
        const examMap = Object.fromEntries(exams.map((e) => [e.id, {
            name: e.name,
            classId: e.classId,
            className: classMap[e.classId]?.name ?? `Class ${e.classId}`,
            academicYear: classMap[e.classId]?.academicYear ?? null,
        }]));
        let totalCredits = 0;
        let weightedPoints = 0;
        const subjectGpaList = results.map(r => {
            const sub = subjectMap[r.subjectId];
            const credits = sub?.credits ?? 4;
            const gpaPoint = gradeToGpaPoint(r.grade);
            totalCredits += credits;
            weightedPoints += (credits * gpaPoint);
            return {
                subjectId: r.subjectId,
                subjectName: sub?.name ?? `Subject ${r.subjectId}`,
                credits,
                grade: r.grade,
                gpaPoint,
            };
        });
        const cgpa = totalCredits > 0 ? Number((weightedPoints / totalCredits).toFixed(2)) : 0;
        const firstExam = results[0] ? examMap[results[0].examId] : null;
        const studentClass = classMap[student.classId];
        return res.json({
            studentId,
            studentName: student.name,
            rollNumber: student.rollNumber ?? null,
            className: firstExam?.className ?? studentClass?.name ?? `Class ${student.classId}`,
            academicYear: firstExam?.academicYear ?? studentClass?.academicYear ?? null,
            cgpa,
            totalCredits,
            subjects: subjectGpaList,
            results: results.map((r) => ({
                examName: examMap[r.examId]?.name ?? `Exam ${r.examId}`,
                subjectName: subjectMap[r.subjectId]?.name ?? `Subject ${r.subjectId}`,
                marksObtained: Number(r.marksObtained),
                maxMarks: Number(r.maxMarks),
                grade: r.grade || calcGrade(Number(r.marksObtained), Number(r.maxMarks)),
                className: examMap[r.examId]?.className ?? studentClass?.name ?? null,
                academicYear: examMap[r.examId]?.academicYear ?? studentClass?.academicYear ?? null,
            })),
        });
    } catch (err) {
        req.log.error({ err }, "Calculate GPA error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// DELETE /api/exams/:id

router.delete('/exams/:id', requireRole(...MANAGE_EXAM), async (req, res) => {
    try {
        const examId = parseInt(String(req.params.id));

        if (isNaN(examId)) {
            return res.status(400).json({ error: "Invalid exam ID" });
        }

        // Check if exam exists
        const [exam] = await db
            .select()
            .from(examsTable)
            .where(eq(examsTable.id, examId));

        if (!exam) {
            return res.status(404).json({ error: "Exam not found" });
        }

        // Prevent deleting ongoing exams
        if (exam.status === "ongoing") {
            return res.status(400).json({ 
                error: "Cannot delete an ongoing exam" 
            });
        }

        // Delete the exam
        await db
            .delete(examsTable)
            .where(eq(examsTable.id, examId));

        return res.json({ 
            success: true,
            message: "Exam deleted successfully" 
        });

    } catch (err) {
        req.log.error({ err }, "Delete exam error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.get(
  "/report-card/:studentId",
  requireRole("admin", "teacher", "student", "parent", "clerk"),
  async (req, res) => {
    try {
      const studentId = parseInt(String(req.params.studentId));

      // Permission checks
      if (req.user?.role === "student" || req.user?.role === "parent") {
        const { resolveOwnStudentIds } = await import("../lib/scope");
        const ownIds = new Set(await resolveOwnStudentIds(req.user));

        if (!ownIds.has(studentId)) {
          return res.status(403).json({ error: "Forbidden" });
        }
      } else if (req.user?.role === "teacher") {
        const { resolveTeacherClassIds } = await import("../lib/scope");

        const classIds = await resolveTeacherClassIds(req.user.id);

        const [student] = await db
          .select()
          .from(studentsTable)
          .where(eq(studentsTable.id, studentId));

        if (!student || !classIds.includes(student.classId)) {
          return res.status(403).json({
            error: "Forbidden",
            details: "Teacher not associated with this student's class",
          });
        }
      }

      // Student Details
      const [student] = await db
        .select()
        .from(studentsTable)
        .where(eq(studentsTable.id, studentId));

      if (!student) {
        return res.status(404).json({ error: "Student not found" });
      }

      // Results
      const results = await db
        .select()
        .from(examResultsTable)
        .where(eq(examResultsTable.studentId, studentId));

      const subjects = await db.select().from(subjectsTable);
      const exams = await db.select().from(examsTable);
      const classes = await db.select().from(classesTable);

      const subjectMap = Object.fromEntries(
        subjects.map((s) => [s.id, s])
      );

      const examMap = Object.fromEntries(
        exams.map((e) => [e.id, e])
      );

      const classMap = Object.fromEntries(classes.map((c) => [c.id, {
        name: `${c.grade}-${c.section}`,
        academicYear: c.academicYear,
      }]));

      const reportResults = results.map((r) => ({
        examName:
          examMap[r.examId]?.name || `Exam ${r.examId}`,
        subjectName:
          subjectMap[r.subjectId]?.name ||
          `Subject ${r.subjectId}`,
        marksObtained: Number(r.marksObtained),
        maxMarks: Number(r.maxMarks),
        grade:
          r.grade ||
          calcGrade(
            Number(r.marksObtained),
            Number(r.maxMarks)
          ),
      }));

      const averageScore =
        results.length > 0
          ? Math.round(
              results.reduce(
                (sum, r) =>
                  sum +
                  (Number(r.marksObtained) /
                    Number(r.maxMarks)) *
                    100,
                0
              ) / results.length
            )
          : 0;

      const passRate =
        results.length > 0
          ? Math.round(
              (results.filter(
                (r) =>
                  (r.grade ||
                    calcGrade(
                      Number(r.marksObtained),
                      Number(r.maxMarks)
                    )) !== "F"
              ).length /
                results.length) *
                100
            )
          : 0;

      return res.json({
  studentId: student.id,
  studentName: student.name,
  rollNumber:
    student.rollNumber ||
    student.admissionNumber ||
    student.studentCode ||
    "-",
  className:
    classMap[student.classId]?.name ||
    `Class ${student.classId}`,
  academicYear: classMap[student.classId]?.academicYear || "-",
  averageScore,
  passRate,
  results: reportResults,
  debug: {
    totalResults: results.length,
    totalReportResults: reportResults.length
  }
});
    } catch (err) {
      req.log.error({ err }, "Report card error");

      return res.status(500).json({
        error: "Internal server error",
      });
    }
  }
);

export default router;
