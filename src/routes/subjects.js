import { Router } from "express";
import { db } from "@workspace/db";
import { subjectsTable, classesTable, staffTable, timetableSlotsTable, examResultsTable, assignmentsTable, lessonPlansTable, studyMaterialsTable, } from "@workspace/db";
import { eq } from "drizzle-orm";
import { CreateSubjectBody, UpdateSubjectBody } from "@workspace/api-zod";
import { requireRole } from "../middlewares/auth";
import { resolveTeacherClassIds } from "../lib/scope";

const router = Router();
async function enrichSubject(s) {
    const cls = s.classId
        ? (await db.select().from(classesTable).where(eq(classesTable.id, s.classId)))[0]
        : undefined;
    const teachers = s.teacherId ? await db.select().from(staffTable).where(eq(staffTable.id, s.teacherId)) : [];
    return {
        ...s,
        className: cls ? `${cls.grade}-${cls.section}` : null,
        teacherName: teachers[0]?.name ?? null,
    };
}
router.get("/subjects", requireRole("admin", "teacher", "student", "parent", "clerk", "driver"), async (req, res) => {
        try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const all = await db.select().from(subjectsTable);
        const classes = await db.select().from(classesTable);
        const staff = await db.select().from(staffTable);
        const classMap = Object.fromEntries(classes.map((c) => [c.id, `${c.grade}-${c.section}`]));
        const staffMap = Object.fromEntries(staff.map((s) => [s.id, s.name]));
        let filtered = all;
        if (me.role === "teacher") {
            const myStaff = staff.find((s) => s.userId === me.id || s.email === me.email);
            const teacherClassIds = new Set(await resolveTeacherClassIds(me.id));
            filtered = myStaff
                ? all.filter((s) => s.teacherId === myStaff.id || (s.classId != null && teacherClassIds.has(s.classId)))
                : [];
        }
        return res.json(filtered.map((s) => ({
            ...s,
            className: s.classId ? (classMap[s.classId] ?? null) : null,
            teacherName: s.teacherId ? (staffMap[s.teacherId] ?? null) : null,
        })));
    }
    catch (err) {
        req.log.error({ err }, "List subjects error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/subjects", requireRole("admin"), async (req, res) => {
    try {
        const parsed = CreateSubjectBody.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: "Validation failed", message: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
        }
        const data = parsed.data;
        const [subject] = await db.insert(subjectsTable).values({
            name: data.name,
            code: data.code,
            classId: data.classId ?? null,
            teacherId: data.teacherId ?? null,
            description: data.description ?? null,
            credits: data.credits ?? null,
        }).returning();
        return res.status(201).json(await enrichSubject(subject));
    }
    catch (err) {
        req.log.error({ err }, "Create subject error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.get("/subjects/:id", requireRole("admin", "teacher", "student", "parent", "clerk", "driver"), async (req, res) => {
        try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const all = await db.select().from(subjectsTable).where(eq(subjectsTable.id, parseInt(String(req.params.id))));
        if (!all[0])
            return res.status(404).json({ error: "Not found" });
        if (me.role === "teacher") {
            const staff = await db.select().from(staffTable);
            const myStaff = staff.find((s) => s.userId === me.id || s.email === me.email);
            if (!myStaff || all[0].teacherId !== myStaff.id)
                return res.status(403).json({ error: "Forbidden" });
        }
        return res.json(await enrichSubject(all[0]));
    }
    catch (err) {
        req.log.error({ err }, "Get subject error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.patch("/subjects/:id", requireRole("admin"), async (req, res) => {
    try {
        const parsed = UpdateSubjectBody.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: "Validation failed", message: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
        }
        const data = parsed.data;
        const upd = {};
        if (data.name !== undefined && data.name !== null)
            upd.name = data.name;
        if (data.code !== undefined && data.code !== null)
            upd.code = data.code;
        if (data.classId !== undefined)
            upd.classId = data.classId;
        if (data.teacherId !== undefined)
            upd.teacherId = data.teacherId;
        if (data.description !== undefined)
            upd.description = data.description;
        if (data.credits !== undefined)
            upd.credits = data.credits;
        const [updated] = await db.update(subjectsTable).set(upd).where(eq(subjectsTable.id, parseInt(String(req.params.id)))).returning();
        if (!updated)
            return res.status(404).json({ error: "Not found" });
        return res.json(await enrichSubject(updated));
    }
    catch (err) {
        req.log.error({ err }, "Update subject error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.delete("/subjects/:id", requireRole("admin"), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        if (Number.isNaN(id))
            return res.status(400).json({ error: "Invalid id" });
        const checks = [];
        const [timetable, exams, assignments, lessonPlans, materials] = await Promise.all([
            db.select({ id: timetableSlotsTable.id }).from(timetableSlotsTable).where(eq(timetableSlotsTable.subjectId, id)),
            db.select({ id: examResultsTable.id }).from(examResultsTable).where(eq(examResultsTable.subjectId, id)),
            db.select({ id: assignmentsTable.id }).from(assignmentsTable).where(eq(assignmentsTable.subjectId, id)),
            db.select({ id: lessonPlansTable.id }).from(lessonPlansTable).where(eq(lessonPlansTable.subjectId, id)),
            db.select({ id: studyMaterialsTable.id }).from(studyMaterialsTable).where(eq(studyMaterialsTable.subjectId, id)),
        ]);
        if (timetable.length)
            checks.push({ label: `${timetable.length} timetable slot${timetable.length > 1 ? "s" : ""}`, count: timetable.length });
        if (exams.length)
            checks.push({ label: `${exams.length} exam result${exams.length > 1 ? "s" : ""}`, count: exams.length });
        if (assignments.length)
            checks.push({ label: `${assignments.length} assignment${assignments.length > 1 ? "s" : ""}`, count: assignments.length });
        if (lessonPlans.length)
            checks.push({ label: `${lessonPlans.length} lesson plan${lessonPlans.length > 1 ? "s" : ""}`, count: lessonPlans.length });
        if (materials.length)
            checks.push({ label: `${materials.length} study material${materials.length > 1 ? "s" : ""}`, count: materials.length });
        if (checks.length > 0) {
            return res.status(409).json({
                error: "Cannot delete subject",
                message: `This subject is referenced by ${checks.map((c) => c.label).join(", ")}. Remove them first.`,
                references: checks,
            });
        }
        const [deleted] = await db.delete(subjectsTable).where(eq(subjectsTable.id, id)).returning();
        if (!deleted)
            return res.status(404).json({ error: "Not found" });
        return res.status(204).send();
    }
    catch (err) {
        req.log.error({ err }, "Delete subject error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
export default router;
