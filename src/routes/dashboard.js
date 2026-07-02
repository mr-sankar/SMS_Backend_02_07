import { Router } from "express";
import { db } from "@workspace/db";
import { studentsTable, staffTable, classesTable, feeRecordsTable, attendanceTable, periodAttendanceTable, announcementsTable, admissionsTable, hostelRoomsTable, } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { requireRole } from "../middlewares/auth";
import { formatClassName } from "../lib/class-format";
const router = Router();
function isActiveAnnouncement(announcement, now = new Date()) {
    const publishAt = announcement.publishAt ? new Date(announcement.publishAt) : null;
    const expiresAt = announcement.expiresAt ? new Date(announcement.expiresAt) : null;
    if (publishAt && publishAt > now)
        return false;
    if (expiresAt && expiresAt <= now)
        return false;
    return true;
}
function getClassLevel(cls) {
    const raw = String(cls?.grade ?? "");
    const match = raw.match(/\d+/);
    return match ? Number(match[0]) : null;
}
function isPeriodEligibleClass(cls) {
    const level = getClassLevel(cls);
    return level !== null && level >= 6;
}
function summarizeAttendance(records) {
    const counted = records.filter((r) => r.status !== "excused");
    const present = counted.reduce((sum, r) => sum + (r.status === "present" || r.status === "late" ? 1 : r.status === "half_day" ? 0.5 : 0), 0);
    const absent = counted.length - present;
    return {
        total: counted.length,
        present,
        absent,
        percentage: counted.length > 0 ? Math.round((present / counted.length) * 100) : 0,
    };
}
function summarizeStudentDayAttendance(records) {
    const buckets = new Map();
    for (const record of records) {
        const key = `${record.studentId}:${record.date}`;
        const bucket = buckets.get(key) ?? [];
        bucket.push(record);
        buckets.set(key, bucket);
    }
    let total = 0;
    let present = 0;
    let absent = 0;
    for (const bucket of buckets.values()) {
        const statuses = bucket.map((r) => r.status);
        if (statuses.every((status) => status === "excused"))
            continue;
        total += 1;
        const credit = statuses.some((status) => status === "present" || status === "late")
            ? 1
            : statuses.some((status) => status === "half_day")
                ? 0.5
                : 0;
        present += credit;
        absent += 1 - credit;
    }
    return {
        total,
        present,
        absent,
        percentage: total > 0 ? Math.round((present / total) * 100) : 0,
    };
}
function getDateWindow(days) {
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - (days - 1));
    return {
        start: start.toISOString().split("T")[0],
        end: end.toISOString().split("T")[0],
    };
}
function withinWindow(dateStr, window) {
    return String(dateStr) >= window.start && String(dateStr) <= window.end;
}
// Dashboard is visible to every authenticated role; widgets self-scope.
const DASHBOARD_ROLES = [
    "admin", "teacher", "student", "parent", "clerk", "accountant",
    "hostel_warden", "transport_manager", "driver", "store_manager",
    "vendor", "librarian",
];
router.use("/dashboard", requireRole(...DASHBOARD_ROLES));
router.get("/dashboard/summary", async (req, res) => {
    try {
        const now = new Date();
        const [students] = await db.select({ count: sql `count(*)` }).from(studentsTable).where(eq(studentsTable.status, "active"));
        const [staffCount] = await db.select({ count: sql `count(*)` }).from(staffTable).where(eq(staffTable.status, "active"));
        const [classes] = await db.select({ count: sql `count(*)` }).from(classesTable);
        const [pendingFees] = await db.select({ total: sql `coalesce(sum(amount - coalesce(paid_amount, 0)), 0)` }).from(feeRecordsTable).where(eq(feeRecordsTable.status, "pending"));
        const today = new Date().toISOString().split("T")[0];
        const classesList = await db.select().from(classesTable);
        const dailyClassIds = new Set(classesList.filter((cls) => !isPeriodEligibleClass(cls)).map((cls) => cls.id));
        const periodClassIds = new Set(classesList.filter(isPeriodEligibleClass).map((cls) => cls.id));
        const dailyAttendance = await db.select().from(attendanceTable);
        const periodAttendance = await db.select().from(periodAttendanceTable);
        const todaysAttendance = [
            ...dailyAttendance.filter((row) => row.date === today && dailyClassIds.has(row.classId)),
            ...periodAttendance.filter((row) => row.date === today && periodClassIds.has(row.classId)),
        ];
        const todaySummary = summarizeAttendance(todaysAttendance);
        const announcements = await db.select().from(announcementsTable);
        const [pendingAdmissions] = await db.select({ count: sql `count(*)` }).from(admissionsTable).where(eq(admissionsTable.status, "pending"));
        const hostelRooms = await db.select().from(hostelRoomsTable);
        const totalBeds = hostelRooms.reduce((a, r) => a + r.capacity, 0);
        const occupiedBeds = hostelRooms.reduce((a, r) => a + r.occupied, 0);
        const occupancyRate = totalBeds > 0 ? Math.round((occupiedBeds / totalBeds) * 100) : 0;
        return res.json({
            totalStudents: Number(students.count),
            totalStaff: Number(staffCount.count),
            totalClasses: Number(classes.count),
            pendingFees: Number(pendingFees.total),
            presentToday: todaySummary.percentage,
            presentTodayCount: todaySummary.present,
            presentTodayTotal: todaySummary.total,
            activeAnnouncements: announcements.filter((a) => isActiveAnnouncement(a, now)).length,
            pendingAdmissions: Number(pendingAdmissions.count),
            hostelOccupancy: occupancyRate,
        });
    }
    catch (err) {
        req.log.error({ err }, "Dashboard summary error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.get("/dashboard/recent-activity", async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const role = me.role;
        const now = new Date();
        
        let announcements = (await db.select().from(announcementsTable)).filter((a) => isActiveAnnouncement(a, now));
        
        // Scope announcements by audience
        if (role === "admin") {
            // Admin sees all
        } else if (role === "teacher") {
            announcements = announcements.filter(a => ["all", "staff", "teachers"].includes(a.audience));
        } else if (role === "student") {
            const studentRecs = await db.select().from(studentsTable).where(eq(studentsTable.userId, me.id));
            const classIds = studentRecs.map(s => s.classId);
            announcements = announcements.filter(a => 
                ["all", "students"].includes(a.audience) || 
                (a.audience === "class_specific" && a.classId && classIds.includes(a.classId))
            );
        } else if (role === "parent") {
            const parentPhone = me.phone || "";
            const studentRecs = parentPhone ? await db.select().from(studentsTable).where(eq(studentsTable.parentPhone, parentPhone)) : [];
            const classIds = studentRecs.map(s => s.classId);
            announcements = announcements.filter(a => 
                ["all", "parents"].includes(a.audience) || 
                (a.audience === "class_specific" && a.classId && classIds.includes(a.classId))
            );
        } else if (["clerk", "accountant", "hostel_warden", "transport_manager", "driver", "store_manager", "librarian"].includes(role)) {
            announcements = announcements.filter(a => ["all", "staff"].includes(a.audience));
        } else {
            // vendors, etc
            announcements = announcements.filter(a => a.audience === "all");
        }
        
        // Take latest 5 announcements after filtering
        announcements.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        const limitedAnnouncements = announcements.slice(0, 5);

        let admissions = [];
        if (["admin", "clerk"].includes(role)) {
            admissions = await db.select().from(admissionsTable).limit(3);
        }

        const activities = [
            ...limitedAnnouncements.map((a) => ({
                id: a.id,
                type: "announcement",
                title: "New Announcement",
                description: a.title,
                timestamp: a.createdAt.toISOString(),
                actor: null,
            })),
            ...admissions.map((a) => ({
                id: a.id + 1000,
                type: "admission",
                title: "Admission Application",
                description: `${a.applicantName} applied for ${a.applyingForClass}`,
                timestamp: a.appliedAt.toISOString(),
                actor: a.parentName,
            })),
        ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, 8);
        return res.json(activities);
    }
    catch (err) {
        req.log.error({ err }, "Recent activity error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.get("/dashboard/attendance-overview", async (req, res) => {
    try {
        const today = new Date().toISOString().split("T")[0];
        const classes = await db.select().from(classesTable);
        const dailyClassIds = new Set(classes.filter((cls) => !isPeriodEligibleClass(cls)).map((cls) => cls.id));
        const periodClassIds = new Set(classes.filter(isPeriodEligibleClass).map((cls) => cls.id));
        const dailyAttendance = await db.select().from(attendanceTable);
        const periodAttendance = await db.select().from(periodAttendanceTable);
        const todaySummary = summarizeStudentDayAttendance([
            ...dailyAttendance.filter((row) => row.date === today && dailyClassIds.has(row.classId)),
            ...periodAttendance.filter((row) => row.date === today && periodClassIds.has(row.classId)),
        ]);
        const weekWindow = getDateWindow(7);
        const monthWindow = getDateWindow(30);
        const weekSummary = summarizeStudentDayAttendance([
            ...dailyAttendance.filter((row) => withinWindow(row.date, weekWindow) && dailyClassIds.has(row.classId)),
            ...periodAttendance.filter((row) => withinWindow(row.date, weekWindow) && periodClassIds.has(row.classId)),
        ]);
        const monthSummary = summarizeStudentDayAttendance([
            ...dailyAttendance.filter((row) => withinWindow(row.date, monthWindow) && dailyClassIds.has(row.classId)),
            ...periodAttendance.filter((row) => withinWindow(row.date, monthWindow) && periodClassIds.has(row.classId)),
        ]);
        const byClass = classes
            .map((cls) => {
            const mode = isPeriodEligibleClass(cls) ? "periodwise" : "daily";
            const source = mode === "periodwise" ? periodAttendance : dailyAttendance;
            const recent = source.filter((row) => row.classId === cls.id && withinWindow(row.date, monthWindow));
            const summary = summarizeStudentDayAttendance(recent);
            return {
                className: formatClassName(cls),
                percentage: summary.percentage,
                mode,
                total: summary.total,
                present: summary.present,
                absent: summary.absent,
            };
        })
            .sort((a, b) => a.percentage - b.percentage || String(a.className).localeCompare(String(b.className)))
            .slice(0, 8);
        const todayByClass = classes
            .map((cls) => {
            const mode = isPeriodEligibleClass(cls) ? "periodwise" : "daily";
            const source = mode === "periodwise" ? periodAttendance : dailyAttendance;
            const recent = source.filter((row) => row.classId === cls.id && row.date === today);
            const summary = summarizeStudentDayAttendance(recent);
            return {
                className: formatClassName(cls),
                percentage: summary.percentage,
                mode,
                total: summary.total,
                present: summary.present,
                absent: summary.absent,
            };
        })
            .sort((a, b) => a.percentage - b.percentage || String(a.className).localeCompare(String(b.className)))
            .slice(0, 8);
        return res.json({
            today: todaySummary,
            thisWeek: weekSummary,
            thisMonth: monthSummary,
            byClass,
            todayByClass,
        });
    }
    catch (err) {
        req.log.error({ err }, "Attendance overview error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.get("/dashboard/fee-collection", async (req, res) => {
    try {
        const [paid] = await db.select({ total: sql `coalesce(sum(coalesce(paid_amount, amount)), 0)` }).from(feeRecordsTable).where(eq(feeRecordsTable.status, "paid"));
        const [pending] = await db.select({ total: sql `coalesce(sum(amount - coalesce(paid_amount, 0)), 0)` }).from(feeRecordsTable).where(eq(feeRecordsTable.status, "pending"));
        const [overdue] = await db.select({ total: sql `coalesce(sum(amount), 0)` }).from(feeRecordsTable).where(eq(feeRecordsTable.status, "overdue"));
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const collectionByMonth = months.map((m) => ({ month: m, amount: Math.floor(Math.random() * 500000) + 200000 }));
        return res.json({
            totalCollected: Number(paid.total),
            totalPending: Number(pending.total),
            totalOverdue: Number(overdue.total),
            collectionByMonth,
        });
    }
    catch (err) {
        req.log.error({ err }, "Fee collection stats error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
export default router;
