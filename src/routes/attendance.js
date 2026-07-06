import { Router } from "express";
import { db } from "@workspace/db";
import { attendanceTable, studentsTable, classesTable, staffTable, staffAttendanceTable, staffCheckinsTable, periodAttendanceTable, behaviorLogsTable, timetableSlotsTable, subjectsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { requireRole } from "../middlewares/auth";
import { resolveOwnStudentIds } from "../lib/scope";
import { formatClassName } from "../lib/class-format";

const router = Router();
function getClassLevel(cls) {
    const raw = String(cls?.grade ?? "");
    const match = raw.match(/\d+/);
    return match ? Number(match[0]) : null;
}
function isPeriodEligibleClass(cls) {
    const level = getClassLevel(cls);
    return level !== null && level >= 6;
}
function getAttendanceMode(cls) {
    return isPeriodEligibleClass(cls) ? "periodwise" : "daily";
}

function getStaffAttendanceSortTime(record) {
    const rawValue = record?.checkInTime ?? record?.checkOutTime ?? record?.createdAt ?? `${record?.date ?? ""}T00:00:00`;
    const parsed = new Date(rawValue);
    if (!Number.isNaN(parsed.getTime())) {
        return parsed.getTime();
    }
    const fallback = Date.parse(`${record?.date ?? ""}T00:00:00`);
    return Number.isNaN(fallback) ? 0 : fallback;
}

router.get("/attendance", requireRole("admin", "teacher", "parent", "student", "clerk"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const { classId, date, studentId } = req.query;
        const students = await db.select().from(studentsTable);
        const classes = await db.select().from(classesTable);
        const classMap = Object.fromEntries(classes.map((c) => [c.id, `${c.grade}-${c.section}`]));
        const dailyEligibleClassIds = new Set(classes.map((cls) => cls.id));
        const studentMap = Object.fromEntries(students.map((s) => [s.id, { name: s.name, avatarUrl: s.avatarUrl }]));
        let all = await db.select().from(attendanceTable);
        all = all.filter((a) => dailyEligibleClassIds.has(a.classId));
        // ── SCOPING: student/parent only see their own / their children's records ──
        if (me.role === "student" || me.role === "parent") {
            const ownIds = new Set(await resolveOwnStudentIds(me));
            if (studentId) {
                const sid = parseInt(String(studentId));
                if (!ownIds.has(sid))
                    return res.status(403).json({ error: "Forbidden" });
            }
            if (classId) {
                const { resolveOwnClassIds } = await import("../lib/scope");
                const ownClassIds = new Set(await resolveOwnClassIds(me));
                if (!ownClassIds.has(parseInt(String(classId))))
                    return res.status(403).json({ error: "Forbidden" });
            }
            all = all.filter((a) => ownIds.has(a.studentId));
        } else if (me.role === "teacher") {
            const { resolveTeacherClassIds } = await import("../lib/scope");
            const allowed = await resolveTeacherClassIds(me.id);
            if (classId) {
                if (!allowed.includes(parseInt(String(classId))))
                    return res.status(403).json({ error: "Forbidden", details: "Teacher not associated with this class" });
            }
            if (studentId) {
                const [stud] = await db.select().from(studentsTable).where(eq(studentsTable.id, parseInt(String(studentId))));
                if (!stud || !allowed.includes(stud.classId))
                    return res.status(403).json({ error: "Forbidden", details: "Teacher not associated with this student's class" });
            }
            all = all.filter((a) => allowed.includes(a.classId));
        }
        if (classId)
            all = all.filter((a) => a.classId === parseInt(String(classId)));
        if (date)
            all = all.filter((a) => a.date === String(date));
        if (studentId)
            all = all.filter((a) => a.studentId === parseInt(String(studentId)));
        return res.json(all.map((a) => ({
            ...a,
            studentName: studentMap[a.studentId]?.name ?? `Student ${a.studentId}`,
            studentAvatarUrl: studentMap[a.studentId]?.avatarUrl ?? null,
            className: classMap[a.classId] ?? null,
        })));
    }
    catch (err) {
        req.log.error({ err }, "List attendance error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/attendance", requireRole("admin", "teacher"), async (req, res) => {
    try {
        const data = req.body;
        if (req.user?.role === "teacher") {
            const { resolveTeacherClassIds } = await import("../lib/scope");
            const allowed = await resolveTeacherClassIds(req.user.id);
            if (!allowed.includes(Number(data.classId)))
                return res.status(403).json({ error: "Teachers can only mark attendance for their assigned classes" });
        }
        const [targetClass] = await db.select().from(classesTable).where(eq(classesTable.id, Number(data.classId)));
        if (!targetClass) {
            return res.status(400).json({ error: "Selected class not found" });
        }
        // Allow daily attendance marking for all classes, regardless of getAttendanceMode(targetClass)
        const existing = await db.select().from(attendanceTable).where(and(
            eq(attendanceTable.studentId, Number(data.studentId)),
            eq(attendanceTable.classId, Number(data.classId)),
            eq(attendanceTable.date, String(data.date))
        ));
        const values = {
            studentId: Number(data.studentId),
            classId: Number(data.classId),
            date: data.date,
            status: data.status,
            remarks: data.remarks ?? null,
            markedById: req.user?.id ?? null,
        };
        const wasUpdated = existing.length > 0;
        const [record] = wasUpdated
            ? await db.update(attendanceTable).set(values).where(eq(attendanceTable.id, existing[0].id)).returning()
            : await db.insert(attendanceTable).values(values).returning();
        const students = await db.select().from(studentsTable).where(eq(studentsTable.id, Number(data.studentId)));
        return res.status(201).json({
            ...record,
            wasUpdated,
            studentName: students[0]?.name ?? `Student ${data.studentId}`,
            className: formatClassName(targetClass),
        });
    }
    catch (err) {
        req.log.error({ err }, "Mark attendance error");
        return res.status(500).json({ error: "Internal server error" });
    }
});


router.get("/attendance/staff", requireRole("admin", "clerk", "teacher"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const canViewStaffReasons = me.role === "admin";
        const { date, staffId, department } = req.query;
        let staffList = await db.select().from(staffTable);
        const staffMap = Object.fromEntries(staffList.map((s) => [s.id, s.name]));
        const staffByUserId = Object.fromEntries(staffList.filter((s) => s.userId).map((s) => [s.userId, s]));
        const selectedDepartment = department ? String(department).trim() : "";
        if (me.role === "teacher") {
            staffList = staffList.filter((s) => s.userId === me.id || s.email === me.email);
            if (staffList.length === 0)
                return res.json([]);
        }
        if (selectedDepartment) {
            staffList = staffList.filter((s) => String(s.department ?? "").trim() === selectedDepartment);
        }
        if (staffId) {
            const targetStaffId = parseInt(String(staffId));
            staffList = staffList.filter((s) => s.id === targetStaffId);
        }
        const selectedStaffIds = new Set(staffList.map((s) => s.id));
        let all = await db.select().from(staffAttendanceTable);
        let checkins = await db.select().from(staffCheckinsTable);
        if (me.role === "teacher") {
            all = all.filter((a) => selectedStaffIds.has(a.staffId));
            checkins = checkins.filter((a) => a.userId === me.id);
        }
        all = all.filter((a) => selectedStaffIds.has(a.staffId));
        checkins = checkins.filter((a) => selectedStaffIds.has(staffByUserId[a.userId]?.id));
        if (date)
            all = all.filter((a) => a.date === String(date));
        if (date)
            checkins = checkins.filter((a) => a.date === String(date));
        const recordsByStaffDate = new Map();
        const rosterDate = date ? String(date) : new Date().toISOString().split("T")[0];
        for (const staff of staffList) {
            recordsByStaffDate.set(`${staff.id}:${rosterDate}`, {
                id: `roster-${staff.id}-${rosterDate}`,
                staffId: staff.id,
                userId: staff.userId ?? null,
                date: rosterDate,
                status: "pending",
                remarks: null,
                checkInTime: null,
                checkOutTime: null,
                checkInReason: null,
                checkOutReason: null,
                staffName: staff.name ?? `Staff ${staff.id}`,
                staffRole: staff.role,
                staffDepartment: staff.department ?? null,
                source: "staff_roster",
            });
        }
        for (const record of all) {
            recordsByStaffDate.set(`${record.staffId}:${record.date}`, {
                ...record,
                staffName: staffMap[record.staffId] ?? `Staff ${record.staffId}`,
                staffDepartment: staffList.find((s) => s.id === record.staffId)?.department ?? null,
                source: "staff_attendance",
            });
        }
        for (const checkin of checkins) {
            const staff = staffByUserId[checkin.userId];
            if (!staff)
                continue;
            const key = `${staff.id}:${checkin.date}`;
            const existing = recordsByStaffDate.get(key) ?? {};
            recordsByStaffDate.set(key, {
                ...existing,
                id: existing.id ?? checkin.id,
                staffId: staff.id,
                userId: checkin.userId,
                date: checkin.date,
                status: existing.status ?? (checkin.checkInTime ? "present" : "absent"),
                remarks: existing.remarks ?? null,
                checkInTime: checkin.checkInTime ?? existing.checkInTime ?? null,
                checkOutTime: checkin.checkOutTime ?? existing.checkOutTime ?? null,
                checkInReason: canViewStaffReasons ? checkin.checkInReason ?? null : null,
                checkOutReason: canViewStaffReasons ? checkin.checkOutReason ?? null : null,
                createdAt: checkin.createdAt ?? existing.createdAt ?? null,
                staffName: staff.name ?? staffMap[staff.id] ?? `Staff ${staff.id}`,
                staffRole: staff.role,
                staffDepartment: staff.department ?? null,
                source: "staff_checkins",
            });
        }
        return res.json(Array.from(recordsByStaffDate.values()).sort((a, b) => {
            const aTime = getStaffAttendanceSortTime(a);
            const bTime = getStaffAttendanceSortTime(b);
            if (bTime !== aTime)
                return bTime - aTime;
            return String(b.id ?? "").localeCompare(String(a.id ?? ""));
        }));
    }
    catch (err) {
        req.log.error({ err }, "List staff attendance error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/attendance/staff", requireRole("admin", "clerk"), async (req, res) => {
    try {
        const data = req.body;
        const [record] = await db.insert(staffAttendanceTable).values({
            staffId: Number(data.staffId),
            date: data.date,
            status: data.status,
            remarks: data.remarks ?? null,
            checkInTime: data.checkInTime ?? null,
            checkOutTime: data.checkOutTime ?? null,
        }).returning();
        const staffRows = await db.select().from(staffTable).where(eq(staffTable.id, Number(data.staffId)));
        return res.status(201).json({
            ...record,
            staffName: staffRows[0]?.name ?? `Staff ${data.staffId}`,
        });
    }
    catch (err) {
        req.log.error({ err }, "Mark staff attendance error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/attendance/period", requireRole("admin", "teacher", "parent", "student", "clerk"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const { classId, date, studentId, timetableSlotId } = req.query;
        const students = await db.select().from(studentsTable);
        const classes = await db.select().from(classesTable);
        const slots = await db.select().from(timetableSlotsTable);
        const subjects = await db.select().from(subjectsTable);
        const staff = await db.select().from(staffTable);
        const classMap = Object.fromEntries(classes.map((c) => [c.id, formatClassName(c)]));
        const periodEligibleClassIds = new Set(classes.filter(isPeriodEligibleClass).map((c) => c.id));
        const studentMap = Object.fromEntries(students.map((s) => [s.id, { name: s.name, avatarUrl: s.avatarUrl, rollNumber: s.rollNumber }]));
        const subjectMap = Object.fromEntries(subjects.map((s) => [s.id, s.name]));
        const staffMap = Object.fromEntries(staff.map((s) => [s.id, s.name]));
        const slotMap = Object.fromEntries(slots.map((s) => [s.id, s]));
        let all = await db.select().from(periodAttendanceTable);
        all = all.filter((a) => periodEligibleClassIds.has(a.classId));
        if (me.role === "student" || me.role === "parent") {
            const ownIds = new Set(await resolveOwnStudentIds(me));
            if (studentId) {
                const sid = parseInt(String(studentId));
                if (!ownIds.has(sid))
                    return res.status(403).json({ error: "Forbidden" });
            }
            all = all.filter((a) => ownIds.has(a.studentId));
        } else if (me.role === "teacher") {
            const { resolveTeacherClassIds } = await import("../lib/scope");
            const allowed = await resolveTeacherClassIds(me.id);
            if (classId) {
                if (!allowed.includes(parseInt(String(classId))))
                    return res.status(403).json({ error: "Forbidden", details: "Teacher not associated with this class" });
            }
            if (studentId) {
                const [stud] = await db.select().from(studentsTable).where(eq(studentsTable.id, parseInt(String(studentId))));
                if (!stud || !allowed.includes(stud.classId))
                    return res.status(403).json({ error: "Forbidden", details: "Teacher not associated with this student's class" });
            }
            all = all.filter((a) => allowed.includes(a.classId));
        }
        if (classId)
            all = all.filter((a) => a.classId === parseInt(String(classId)));
        if (date)
            all = all.filter((a) => a.date === String(date));
        if (studentId)
            all = all.filter((a) => a.studentId === parseInt(String(studentId)));
        if (timetableSlotId)
            all = all.filter((a) => a.timetableSlotId === parseInt(String(timetableSlotId)));
        return res.json(all.map((a) => ({
            ...a,
            studentName: studentMap[a.studentId]?.name ?? `Student ${a.studentId}`,
            studentAvatarUrl: studentMap[a.studentId]?.avatarUrl ?? null,
            rollNumber: studentMap[a.studentId]?.rollNumber ?? null,
            className: classMap[a.classId] ?? null,
            subjectName: subjectMap[slotMap[a.timetableSlotId]?.subjectId] ?? null,
            teacherName: staffMap[slotMap[a.timetableSlotId]?.staffId] ?? null,
            periodLabel: slotMap[a.timetableSlotId] ? `${slotMap[a.timetableSlotId].startTime}-${slotMap[a.timetableSlotId].endTime}` : null,
            dayOfWeek: slotMap[a.timetableSlotId]?.dayOfWeek ?? null,
        })));
    }
    catch (err) {
        req.log.error({ err }, "List period attendance error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/attendance/period", requireRole("teacher"), async (req, res) => {
    try {
        const data = req.body;
        const validStatuses = new Set(["present", "absent", "late"]);
        if (!data.studentId || !data.classId || !data.timetableSlotId || !data.date || !validStatuses.has(String(data.status))) {
            return res.status(400).json({ error: "studentId, classId, timetableSlotId, date and a valid period status are required" });
        }
        const [slot] = await db.select().from(timetableSlotsTable).where(eq(timetableSlotsTable.id, Number(data.timetableSlotId)));
        if (!slot || slot.classId !== Number(data.classId)) {
            return res.status(400).json({ error: "Selected period does not belong to the target class" });
        }
        const [targetClass] = await db.select().from(classesTable).where(eq(classesTable.id, Number(data.classId)));
        if (!targetClass)
            return res.status(400).json({ error: "Selected class not found" });
        if (!isPeriodEligibleClass(targetClass))
            return res.status(400).json({ error: "Periodwise attendance is allowed only from Class 6 and above" });
        const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, Number(data.studentId)));
        if (!student || student.classId !== Number(data.classId)) {
            return res.status(400).json({ error: "Selected student does not belong to the target class" });
        }
        if (req.user?.role === "teacher") {
            const { resolveTeacherClassIds } = await import("../lib/scope");
            const allowed = await resolveTeacherClassIds(req.user.id);
            if (!allowed.includes(Number(data.classId)))
                return res.status(403).json({ error: "Teachers can only mark attendance for their assigned classes" });
            const staff = await db.select().from(staffTable);
            const myStaff = staff.find((s) => s.userId === req.user.id || s.email === req.user.email);
            if (!myStaff || slot.staffId !== myStaff.id)
                return res.status(403).json({ error: "Teachers can only mark their own timetable periods" });
        }
        const existing = await db.select().from(periodAttendanceTable).where(and(
            eq(periodAttendanceTable.studentId, Number(data.studentId)),
            eq(periodAttendanceTable.timetableSlotId, Number(data.timetableSlotId)),
            eq(periodAttendanceTable.date, data.date)
        ));
        const values = {
            studentId: Number(data.studentId),
            classId: Number(data.classId),
            timetableSlotId: Number(data.timetableSlotId),
            date: data.date,
            status: data.status,
            lateMinutes: data.status === "late" && data.lateMinutes ? Number(data.lateMinutes) : null,
            remarks: data.remarks ?? null,
            markedById: req.user?.id ?? null,
        };
        const wasUpdated = existing.length > 0;
        const [record] = wasUpdated
            ? await db.update(periodAttendanceTable).set(values).where(eq(periodAttendanceTable.id, existing[0].id)).returning()
            : await db.insert(periodAttendanceTable).values(values).returning();
        const classes = await db.select().from(classesTable).where(eq(classesTable.id, Number(data.classId)));
        const subjects = await db.select().from(subjectsTable).where(eq(subjectsTable.id, slot.subjectId));
        const staff = await db.select().from(staffTable).where(eq(staffTable.id, slot.staffId));
        return res.status(201).json({
            ...record,
            wasUpdated,
            studentName: student.name ?? `Student ${data.studentId}`,
            studentAvatarUrl: student.avatarUrl ?? null,
            rollNumber: student.rollNumber ?? null,
            className: classes[0] ? formatClassName(classes[0]) : null,
            subjectName: subjects[0]?.name ?? null,
            teacherName: staff[0]?.name ?? null,
            periodLabel: `${slot.startTime}-${slot.endTime}`,
            dayOfWeek: slot.dayOfWeek,
        });
    }
    catch (err) {
        req.log.error({ err }, "Mark period attendance error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/attendance/device-logs", async (req, res) => {
    try {
        const { rfidCardNumber } = req.body;
        if (!rfidCardNumber) {
            return res.status(400).json({ error: "rfidCardNumber is required" });
        }
        const todayStr = new Date().toISOString().split("T")[0];
        const nowTime = new Date().toTimeString().split(" ")[0]; // "HH:MM:SS"
        // Try student match
        const students = await db.select().from(studentsTable).where(eq(studentsTable.rollNumber, rfidCardNumber));
        if (students.length > 0) {
            const student = students[0];
            const existing = await db.select().from(attendanceTable).where(and(
                eq(attendanceTable.studentId, student.id),
                eq(attendanceTable.date, todayStr)
            ));
            if (existing.length === 0) {
                await db.insert(attendanceTable).values({
                    studentId: student.id,
                    classId: student.classId,
                    date: todayStr,
                    status: "present",
                    remarks: "RFID Scan Check-In",
                    markedById: 1
                });
            }
            return res.json({ success: true, type: "student", studentId: student.id, name: student.name });
        }
        // Try staff match
        const staffList = await db.select().from(staffTable).where(eq(staffTable.staffId, rfidCardNumber));
        if (staffList.length > 0) {
            const staff = staffList[0];
            const existing = await db.select().from(staffAttendanceTable).where(and(
                eq(staffAttendanceTable.staffId, staff.id),
                eq(staffAttendanceTable.date, todayStr)
            ));
            if (existing.length === 0) {
                await db.insert(staffAttendanceTable).values({
                    staffId: staff.id,
                    date: todayStr,
                    status: "present",
                    checkInTime: nowTime,
                    remarks: "RFID Check-In"
                });
            } else {
                const att = existing[0];
                if (!att.checkOutTime) {
                    await db.update(staffAttendanceTable).set({
                        checkOutTime: nowTime,
                        remarks: "RFID Check-Out"
                    }).where(eq(staffAttendanceTable.id, att.id));
                }
            }
            return res.json({ success: true, type: "staff", staffId: staff.id, name: staff.name });
        }
        return res.status(404).json({ error: "RFID card number not matched with any student or staff" });
    }
    catch (err) {
        req.log.error({ err }, "Device logs scan error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/attendance/jobs/nightly-stats", requireRole("admin"), async (req, res) => {
    try {
        const students = await db.select().from(studentsTable);
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split("T")[0];
        const todayStr = new Date().toISOString().split("T")[0];
        const recentAtt = await db.select().from(attendanceTable);
        const filteredAtt = recentAtt.filter(a => a.date >= thirtyDaysAgoStr);
        let warningCount = 0;
        for (const student of students) {
            const studentAtt = filteredAtt.filter(a => a.studentId === student.id);
            const total = studentAtt.length;
            if (total >= 5) { // calculate if we have at least 5 records
                const presentCount = studentAtt.reduce((sum, a) => sum + (a.status === "present" || a.status === "late" ? 1 : a.status === "half_day" ? 0.5 : 0), 0);
                const rate = (presentCount / total) * 100;
                if (rate < 75) {
                    // check if warning behavior log already recorded today
                    const existingLogs = await db.select().from(behaviorLogsTable).where(and(
                        eq(behaviorLogsTable.studentId, student.id),
                        eq(behaviorLogsTable.category, "attendance"),
                        eq(behaviorLogsTable.date, todayStr)
                    ));
                    if (existingLogs.length === 0) {
                        await db.insert(behaviorLogsTable).values({
                            studentId: student.id,
                            classId: student.classId,
                            type: "negative",
                            category: "attendance",
                            description: `Low attendance warning: ${rate.toFixed(1)}% rate over last 30 days.`,
                            date: todayStr,
                            points: -5
                        });
                        warningCount++;
                    }
                }
            }
        }
        return res.json({ success: true, message: `Nightly stats processed. Warnings generated for ${warningCount} students.` });
    }
    catch (err) {
        req.log.error({ err }, "Nightly stats job error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

export default router;
