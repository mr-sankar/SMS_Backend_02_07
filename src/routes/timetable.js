import { Router } from "express";
import { db } from "@workspace/db";
import { timetableSlotsTable, classesTable, subjectsTable, staffTable, studentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireRole } from "../middlewares/auth";
import { resolveOwnClassIds } from "../lib/scope";
const router = Router();
function timesOverlap(aStart, aEnd, bStart, bEnd) {
    return String(aStart) < String(bEnd) && String(aEnd) > String(bStart);
}
router.get("/timetable", requireRole("admin", "teacher", "student", "parent", "clerk"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const { classId, staffId } = req.query;
        const classes = await db.select().from(classesTable);
        const subjects = await db.select().from(subjectsTable);
        const staff = await db.select().from(staffTable);
        const students = await db.select().from(studentsTable);
        const classMap = Object.fromEntries(classes.map((c) => [c.id, `${c.grade}-${c.section}`]));
        const subjectMap = Object.fromEntries(subjects.map((s) => [s.id, s.name]));
        const staffMap = Object.fromEntries(staff.map((s) => [s.id, s.name]));
        let all = await db.select().from(timetableSlotsTable);
        
        // ── AUTO-SCOPE ──
        if (me.role === "student" || me.role === "parent") {
            const ownClassIds = new Set(await resolveOwnClassIds(me));
            if (classId) {
                const cid = parseInt(String(classId));
                if (!ownClassIds.has(cid))
                    return res.status(403).json({ error: "Forbidden" });
            }
            all = all.filter((t) => ownClassIds.has(t.classId));
        }
        else if (me.role === "teacher") {
            // Find the teacher's staff record
            const myStaff = staff.find((s) => s.userId === me.id || s.email === me.email);
            if (myStaff) {
                // Get ALL classes this teacher teaches (both as class teacher and as subject teacher)
                // First, get classes where this teacher is the class teacher
                const classTeacherClassIds = new Set(
                    classes.filter((c) => c.teacherId === myStaff.id).map((c) => c.id)
                );
                
                // Second, get classes where this teacher teaches any subject (from timetable)
                const teacherTimetableClasses = new Set(
                    all.filter((t) => t.staffId === myStaff.id).map((t) => t.classId)
                );
                
                // Combine both sets
                const allTeacherClassIds = new Set([...classTeacherClassIds, ...teacherTimetableClasses]);
                
                // If classId filter is provided, check if teacher has access
                if (classId) {
                    const cid = parseInt(String(classId));
                    if (!allTeacherClassIds.has(cid))
                        return res.status(403).json({ error: "Forbidden - You don't have access to this class" });
                }
                
                // Filter timetable slots to only show classes the teacher has access to
                all = all.filter((t) => allTeacherClassIds.has(t.classId));
            }
            else {
                // If teacher record not found, return empty
                all = [];
            }
        }
        
        // Apply classId filter if provided
        if (classId)
            all = all.filter((t) => t.classId === parseInt(String(classId)));
        if (staffId)
            all = all.filter((t) => t.staffId === parseInt(String(staffId)));
            
        return res.json(all.map((t) => ({
            ...t,
            className: classMap[t.classId] ?? `Class ${t.classId}`,
            subjectName: subjectMap[t.subjectId] ?? `Subject ${t.subjectId}`,
            teacherName: staffMap[t.staffId] ?? `Staff ${t.staffId}`,
            createdAt: t.createdAt.toISOString(),
        })));
    }
    catch (err) {
        req.log.error({ err }, "List timetable error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/timetable", requireRole("admin"), async (req, res) => {
    try {
        const me = req.user;
        const data = req.body;
        
        // Validate class exists
        const [targetClass] = await db.select().from(classesTable).where(eq(classesTable.id, Number(data.classId)));
        if (!targetClass) {
            return res.status(400).json({ error: "Selected class not found" });
        }
        
        // REMOVE THIS ENTIRE VALIDATION BLOCK:
        // if (!targetClass.teacherId)
        //     return res.status(400).json({ error: "Selected class does not have an assigned teacher" });
        // 
        // let staffId = data.staffId;
        // if (Number(staffId) !== Number(targetClass.teacherId))
        //     return res.status(400).json({ error: "Only the assigned class teacher can be selected for this class" });

        // Use the staffId from request directly (no validation against class teacher)
        const staffId = data.staffId;

        // Check if the selected teacher exists
        const [selectedTeacher] = await db.select().from(staffTable).where(eq(staffTable.id, Number(staffId)));
        if (!selectedTeacher) {
            return res.status(400).json({ error: "Selected teacher not found" });
        }

        // Check if teacher is actually a teacher
        if (selectedTeacher.role !== "teacher") {
            return res.status(400).json({ error: "Selected staff member is not a teacher" });
        }

        // Check for duplicate entry
        const sameDaySlots = await db.select().from(timetableSlotsTable).where(eq(timetableSlotsTable.dayOfWeek, data.dayOfWeek));
        
        const duplicate = sameDaySlots.find((slot) => 
            slot.classId === Number(data.classId) &&
            slot.subjectId === Number(data.subjectId) &&
            slot.staffId === Number(staffId) &&
            slot.startTime === data.startTime &&
            slot.endTime === data.endTime
        );
        
        if (duplicate) {
            return res.status(409).json({ error: "This timetable period already exists" });
        }

        // Check for class time conflict
        const classConflict = sameDaySlots.find((slot) => 
            slot.classId === Number(data.classId) &&
            timesOverlap(data.startTime, data.endTime, slot.startTime, slot.endTime)
        );
        
        if (classConflict) {
            return res.status(409).json({ error: "This class already has a period scheduled during that time" });
        }

        // Check for teacher time conflict
        const teacherConflict = sameDaySlots.find((slot) => 
            slot.staffId === Number(staffId) &&
            timesOverlap(data.startTime, data.endTime, slot.startTime, slot.endTime)
        );
        
        if (teacherConflict) {
            return res.status(409).json({ error: "This teacher already has a period scheduled during that time" });
        }

        // Insert the new timetable slot
        const [slot] = await db.insert(timetableSlotsTable).values({
            classId: data.classId,
            subjectId: data.subjectId,
            staffId,
            dayOfWeek: data.dayOfWeek,
            startTime: data.startTime,
            endTime: data.endTime,
            room: data.room ?? null,
        }).returning();

        // Get related data for response
        const classes = await db.select().from(classesTable).where(eq(classesTable.id, slot.classId));
        const subjects = await db.select().from(subjectsTable).where(eq(subjectsTable.id, slot.subjectId));
        const staff = await db.select().from(staffTable).where(eq(staffTable.id, slot.staffId));

        return res.status(201).json({
            ...slot,
            className: classes[0] ? `${classes[0].grade}-${classes[0].section}` : `Class ${slot.classId}`,
            subjectName: subjects[0]?.name ?? `Subject ${slot.subjectId}`,
            teacherName: staff[0]?.name ?? `Staff ${slot.staffId}`,
            createdAt: slot.createdAt.toISOString(),
        });
    }
    catch (err) {
        req.log.error({ err }, "Create timetable slot error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.delete("/timetable/:id", requireRole("admin"), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        await db.delete(timetableSlotsTable).where(eq(timetableSlotsTable.id, id));
        return res.status(204).send();
    }
    catch (err) {
        req.log.error({ err }, "Delete timetable slot error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
export default router;
