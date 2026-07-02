import { Router } from "express";
import { db } from "@workspace/db";
import { hostelRoomsTable, hostelApplicationsTable, hostelMealsTable, hostelNoticesTable, hostelAttendanceTable, studentsTable, hostelsTable, hostelMaintenanceTable, hostelVisitorsTable, feeRecordsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireRole } from "../middlewares/auth";
import { resolveOwnStudentIds, resolveStudentForUser, resolveChildrenForParent } from "../lib/scope";
const router = Router();
const HOSTEL_INELIGIBLE_MESSAGE = "You are not eligible to apply for this hostel.";
const ACTIVE_APPLICATION_STATUSES = new Set(["pending", "approved", "waitlisted"]);

function normalizeText(value) {
    return value === undefined || value === null ? "" : String(value).trim().toLowerCase();
}

function normalizeGender(value) {
    const gender = normalizeText(value);
    if (["male", "m", "boy", "boys"].includes(gender))
        return "male";
    if (["female", "f", "girl", "girls"].includes(gender))
        return "female";
    return gender;
}

function isStudentEligibleForHostel(student, hostel) {
    const gender = normalizeGender(student?.gender);
    const hostelType = normalizeText(hostel?.type);
    if (gender === "male")
        return hostelType === "boys";
    if (gender === "female")
        return hostelType === "girls";
    return false;
}

router.get("/hostels", requireRole("admin", "hostel_warden", "clerk", "student", "parent"), async (req, res) => {
    try {
        let hostels = await db.select().from(hostelsTable);
        if (req.user?.role === "student") {
            const student = await resolveStudentForUser(req.user);
            if (!student)
                return res.json([]);
            hostels = hostels.filter((hostel) => isStudentEligibleForHostel(student, hostel));
        }
        return res.json(hostels);
    }
    catch (err) {
        req.log.error({ err }, "List hostels error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/hostels", requireRole("admin"), async (req, res) => {
    try {
        const data = req.body;
        const name = String(data.name ?? "").trim();
        if (!name)
            return res.status(400).json({ error: "Hostel block name is required" });
        const existingHostels = await db.select().from(hostelsTable);
        if (existingHostels.some((hostel) => normalizeText(hostel.name) === normalizeText(name))) {
            return res.status(409).json({ error: "Duplicate hostel block", details: "A hostel block with this name already exists." });
        }
        const [hostel] = await db.insert(hostelsTable).values({
            name,
            type: data.type,
            capacity: Number(data.capacity),
            address: data.address ?? null,
        }).returning();
        return res.status(201).json(hostel);
    }
    catch (err) {
        req.log.error({ err }, "Create hostel error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.delete("/hostels/:id", requireRole("admin"), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        const [hostel] = await db.select().from(hostelsTable).where(eq(hostelsTable.id, id));
        if (!hostel)
            return res.status(404).json({ error: "Hostel block not found" });
        const rooms = await db.select().from(hostelRoomsTable).where(eq(hostelRoomsTable.hostelId, id));
        if (rooms.length > 0) {
            return res.status(400).json({ error: "Cannot delete hostel block while rooms exist. Remove rooms first." });
        }
        await db.delete(hostelsTable).where(eq(hostelsTable.id, id));
        return res.json({ success: true });
    }
    catch (err) {
        req.log.error({ err }, "Delete hostel block error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/hostel/rooms", requireRole("admin", "hostel_warden", "clerk", "student", "parent"), async (req, res) => {
    try {
        const rooms = await db.select().from(hostelRoomsTable);
        return res.json(rooms);
    }
    catch (err) {
        req.log.error({ err }, "List hostel rooms error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/hostel/rooms", requireRole("admin"), async (req, res) => {
    try {
        const data = req.body;
        const hostelId = data.hostelId ? Number(data.hostelId) : null;
        if (!hostelId) {
            return res.status(400).json({ error: "Hostel block is required" });
        }
        const [hostel] = await db.select().from(hostelsTable).where(eq(hostelsTable.id, hostelId));
        if (!hostel) {
            return res.status(404).json({ error: "Hostel block not found" });
        }
        const roomNumber = String(data.roomNumber ?? "").trim();
        if (!roomNumber) {
            return res.status(400).json({ error: "Room number is required" });
        }
        const roomCapacity = Number(data.capacity);
        if (!Number.isFinite(roomCapacity) || roomCapacity <= 0) {
            return res.status(400).json({ error: "Room capacity must be a positive number" });
        }
        const existingRooms = await db.select().from(hostelRoomsTable).where(eq(hostelRoomsTable.hostelId, hostelId));
        if (existingRooms.some((room) => String(room.roomNumber).trim().toLowerCase() === roomNumber.toLowerCase())) {
            return res.status(409).json({ error: `Room ${roomNumber} already exists in this hostel block` });
        }
        const usedBeds = existingRooms.reduce((sum, room) => sum + Number(room.capacity), 0);
        const remainingBeds = Number(hostel.capacity) - usedBeds;
        if (roomCapacity > remainingBeds) {
            return res.status(400).json({ error: `Cannot add room with ${roomCapacity} bed(s). Only ${remainingBeds} bed(s) remain in this hostel block.` });
        }
        const [room] = await db.insert(hostelRoomsTable).values({
            roomNumber: data.roomNumber,
            block: data.block,
            floor: Number(data.floor),
            capacity: roomCapacity,
            type: data.type,
            facilities: data.facilities ?? null,
            status: "available",
            occupied: 0,
            monthlyFee: data.monthlyFee ? String(data.monthlyFee) : "3000.00",
            hostelId,
        }).returning();
        return res.status(201).json(room);
    }
    catch (err) {
        req.log.error({ err }, "Create hostel room error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.patch("/hostel/rooms/:id", requireRole("admin"), async (req, res) => {
    try {
        const data = req.body;
        const upd = {};
        if (data.status !== undefined)
            upd.status = data.status;
        if (data.facilities !== undefined)
            upd.facilities = data.facilities;
        if (data.monthlyFee !== undefined)
            upd.monthlyFee = String(data.monthlyFee);
        if (data.hostelId !== undefined)
            upd.hostelId = data.hostelId ? Number(data.hostelId) : null;
        const [updated] = await db.update(hostelRoomsTable).set(upd).where(eq(hostelRoomsTable.id, parseInt(String(req.params.id)))).returning();
        if (!updated)
            return res.status(404).json({ error: "Not found" });
        return res.json(updated);
    }
    catch (err) {
        req.log.error({ err }, "Update hostel room error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.delete("/hostel/rooms/:id", requireRole("admin"), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        const [room] = await db.select().from(hostelRoomsTable).where(eq(hostelRoomsTable.id, id));
        if (!room)
            return res.status(404).json({ error: "Hostel room not found" });
        if (room.occupied > 0)
            return res.status(400).json({ error: "Cannot delete room while occupied. Remove room allocations first." });
        await db.delete(hostelRoomsTable).where(eq(hostelRoomsTable.id, id));
        return res.json({ success: true });
    }
    catch (err) {
        req.log.error({ err }, "Delete hostel room error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/hostel/applications", requireRole("admin", "hostel_warden", "clerk", "student", "parent"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const students = await db.select().from(studentsTable);
        const rooms = await db.select().from(hostelRoomsTable);
        const hostels = await db.select().from(hostelsTable);
        let apps = await db.select().from(hostelApplicationsTable);
        // ── SCOPING ──
        if (me.role === "student" || me.role === "parent") {
            const ownIds = new Set(await resolveOwnStudentIds(me));
            apps = apps.filter((a) => ownIds.has(a.studentId));
        }
        // admin and hostel_warden see all; others see none
        else if (!["admin", "hostel_warden"].includes(me.role)) {
            apps = [];
        }
        const studentMap = Object.fromEntries(students.map((s) => [s.id, s.name]));
        const roomMap = Object.fromEntries(rooms.map((r) => [r.id, r.roomNumber]));
        const hostelMap = Object.fromEntries(hostels.map((h) => [String(h.id), h.name]));
        return res.json(apps.map((a) => ({
            ...a,
            studentName: studentMap[a.studentId] ?? `Student ${a.studentId}`,
            preferredBlockName: hostelMap[String(a.preferredBlock)] ?? a.preferredBlock,
            roomNumber: a.roomId ? (roomMap[a.roomId] ?? null) : null,
            appliedAt: a.appliedAt.toISOString(),
        })));
    }
    catch (err) {
        req.log.error({ err }, "List hostel applications error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/hostel/applications", requireRole("admin", "student", "parent"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const data = req.body;
        if (data.rulesAccepted !== true)
            return res.status(400).json({ error: "You must accept the hostel rules before submitting an application." });
        let studentId;
        const students = await db.select().from(studentsTable);
        if (me.role === "student") {
            const myStudent = await resolveStudentForUser(me);
            if (!myStudent)
                return res.status(403).json({ error: "Student record not found" });
            studentId = myStudent.id;
        }
        else if (me.role === "parent") {
            const myChildren = await resolveChildrenForParent(me);
            const target = data.studentId ? myChildren.find((c) => c.id === Number(data.studentId)) : myChildren[0];
            if (!target)
                return res.status(403).json({ error: "No linked student record" });
            studentId = target.id;
        }
        else if (me.role === "admin") {
            if (!data.studentId)
                return res.status(400).json({ error: "studentId required" });
            studentId = Number(data.studentId);
        }
        else {
            return res.status(403).json({ error: "Forbidden" });
        }
        const target = students.find((s) => s.id === studentId);
        if (!target)
            return res.status(404).json({ error: "Student record not found" });
        const existingApplications = await db.select().from(hostelApplicationsTable).where(eq(hostelApplicationsTable.studentId, studentId));
        if (existingApplications.some((app) => ACTIVE_APPLICATION_STATUSES.has(app.status))) {
            return res.status(409).json({ error: "You already have an active hostel application." });
        }
        const preferredHostelId = Number(data.preferredBlock);
        if (!Number.isFinite(preferredHostelId))
            return res.status(400).json({ error: "Preferred hostel block is required" });
        const [preferredHostel] = await db.select().from(hostelsTable).where(eq(hostelsTable.id, preferredHostelId));
        if (!preferredHostel)
            return res.status(404).json({ error: "Hostel block not found" });
        if (!isStudentEligibleForHostel(target, preferredHostel)) {
            return res.status(403).json({ error: HOSTEL_INELIGIBLE_MESSAGE });
        }
        const matchingRooms = await db.select().from(hostelRoomsTable).where(and(
            eq(hostelRoomsTable.hostelId, preferredHostel.id),
            eq(hostelRoomsTable.type, data.preferredRoomType)
        ));
        if (!matchingRooms.some((room) => room.status === "available" && room.occupied < room.capacity)) {
            return res.status(400).json({ error: "Selected room type is not available in this hostel block." });
        }
        const [app] = await db.insert(hostelApplicationsTable).values({
            studentId,
            preferredBlock: String(preferredHostel.id),
            preferredRoomType: data.preferredRoomType,
            remarks: data.remarks ?? null,
            status: "pending",
        }).returning();
        return res.status(201).json({
            ...app,
            studentName: target?.name ?? `Student ${studentId}`,
            preferredBlockName: preferredHostel.name,
            roomNumber: null,
            appliedAt: app.appliedAt.toISOString(),
        });
    }
    catch (err) {
        req.log.error({ err }, "Apply for hostel error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.patch("/hostel/applications/:id", requireRole("admin", "hostel_warden"), async (req, res) => {
    try {
        const data = req.body;
        const id = parseInt(String(req.params.id));
        const [cur] = await db.select().from(hostelApplicationsTable).where(eq(hostelApplicationsTable.id, id));
        if (!cur)
            return res.status(404).json({ error: "Not found" });

        const oldStatus = cur.status;
        const newStatus = data.status;
        const oldRoomId = cur.roomId;
        const newRoomId = data.roomId !== undefined ? data.roomId : oldRoomId;

        // If transitioning to approved
        if (newStatus === "approved" && oldStatus !== "approved") {
            if (!newRoomId) {
                return res.status(400).json({ error: "Room allocation is required for approval" });
            }
            const [room] = await db.select().from(hostelRoomsTable).where(eq(hostelRoomsTable.id, Number(newRoomId)));
            if (!room) {
                return res.status(404).json({ error: "Assigned room not found" });
            }
            if (room.occupied >= room.capacity) {
                return res.status(400).json({ error: "Assigned room is at full capacity" });
            }
            // Increment room occupancy
            await db.update(hostelRoomsTable).set({ occupied: room.occupied + 1 }).where(eq(hostelRoomsTable.id, room.id));

            // Book hostel fee invoice
            await db.insert(feeRecordsTable).values({
                studentId: cur.studentId,
                feeType: `Hostel Fee (Room ${room.roomNumber})`,
                amount: room.monthlyFee ? String(room.monthlyFee) : "3000.00",
                dueDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
                academicYear: "2026-2027",
                status: "pending",
                termType: "Monthly",
                concession: "0",
            });
        }
        // If transitioning from approved to rejected/cancelled
        else if (oldStatus === "approved" && (newStatus === "rejected" || newStatus === "cancelled")) {
            if (oldRoomId) {
                const [room] = await db.select().from(hostelRoomsTable).where(eq(hostelRoomsTable.id, oldRoomId));
                if (room && room.occupied > 0) {
                    await db.update(hostelRoomsTable).set({ occupied: room.occupied - 1 }).where(eq(hostelRoomsTable.id, room.id));
                }
            }
        }

        const upd = {};
        if (data.status !== undefined)
            upd.status = data.status;
        if (data.roomId !== undefined)
            upd.roomId = data.roomId;
        if (data.bed !== undefined)
            upd.bed = data.bed;
        if (data.remarks !== undefined)
            upd.remarks = data.remarks;

        const [updated] = await db.update(hostelApplicationsTable).set(upd).where(eq(hostelApplicationsTable.id, id)).returning();
        const students = await db.select().from(studentsTable).where(eq(studentsTable.id, updated.studentId));
        const rooms = updated.roomId ? await db.select().from(hostelRoomsTable).where(eq(hostelRoomsTable.id, updated.roomId)) : [];
        return res.json({
            ...updated,
            studentName: students[0]?.name ?? `Student ${updated.studentId}`,
            roomNumber: rooms[0]?.roomNumber ?? null,
            appliedAt: updated.appliedAt.toISOString(),
        });
    }
    catch (err) {
        req.log.error({ err }, "Update hostel application error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.delete("/hostel/applications/:id", requireRole("admin", "hostel_warden"), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        const [application] = await db
            .select()
            .from(hostelApplicationsTable)
            .where(eq(hostelApplicationsTable.id, id));
        if (!application)
            return res.status(404).json({ error: "Hostel application not found" });
        if (!["approved", "rejected"].includes(application.status))
            return res.status(400).json({ error: "Only approved or rejected hostel applications can be deleted" });

        await db.transaction(async (tx) => {
            if (application.status === "approved" && application.roomId) {
                const [room] = await tx
                    .select()
                    .from(hostelRoomsTable)
                    .where(eq(hostelRoomsTable.id, application.roomId));
                if (room && room.occupied > 0) {
                    await tx
                        .update(hostelRoomsTable)
                        .set({
                            occupied: room.occupied - 1,
                            status: room.status === "full" ? "available" : room.status,
                        })
                        .where(eq(hostelRoomsTable.id, room.id));
                }
            }
            if (application.status === "approved") {
                await tx
                    .delete(hostelAttendanceTable)
                    .where(eq(hostelAttendanceTable.studentId, application.studentId));
            }
            await tx
                .delete(hostelApplicationsTable)
                .where(eq(hostelApplicationsTable.id, id));
        });

        return res.json({ success: true, deletedStatus: application.status });
    }
    catch (err) {
        req.log.error({ err }, "Delete hostel application error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/hostel/summary", requireRole("admin", "hostel_warden", "clerk"), async (req, res) => {
    try {
        const hostels = await db.select().from(hostelsTable);
        const rooms = await db.select().from(hostelRoomsTable);
        const totalBeds = rooms.reduce((a, r) => a + r.capacity, 0);
        const occupied = rooms.reduce((a, r) => a + r.occupied, 0);
        const blocks = [...new Set(rooms.map((r) => r.block))];
        const byBlock = blocks.map((block) => {
            const blockRooms = rooms.filter((r) => r.block === block);
            return {
                block,
                total: blockRooms.reduce((a, r) => a + r.capacity, 0),
                occupied: blockRooms.reduce((a, r) => a + r.occupied, 0),
            };
        });
        return res.json({
            totalBlocks: hostels.length,
            totalRooms: rooms.length,
            totalBeds,
            occupied,
            available: totalBeds - occupied,
            occupancyRate: totalBeds > 0 ? Math.round((occupied / totalBeds) * 100) : 0,
            byBlock,
        });
    }
    catch (err) {
        req.log.error({ err }, "Hostel summary error");
        return res.status(500).json({ error: "Internal server error" });
    }
});


router.get("/hostel/allocations", requireRole("admin", "hostel_warden", "clerk", "student", "parent"), async (req, res) => {
    try {
        const me = req.user;
        if (!me)
            return res.status(401).json({ error: "Not authenticated" });
        const students = await db.select().from(studentsTable);
        const rooms = await db.select().from(hostelRoomsTable);
        const hostels = await db.select().from(hostelsTable);
        const apps = await db.select().from(hostelApplicationsTable).where(eq(hostelApplicationsTable.status, "approved"));
        
        let result = apps;
        if (me.role === "student" || me.role === "parent") {
            const ownIds = new Set(await resolveOwnStudentIds(me));
            result = result.filter((a) => ownIds.has(a.studentId));
        }
        
        const studentMap = Object.fromEntries(students.map((s) => [s.id, s]));
        const roomMap = Object.fromEntries(rooms.map((r) => [r.id, r]));
        const hostelMap = Object.fromEntries(hostels.map((h) => [h.id, h.name]));
        
        return res.json(result.map((a) => {
            const studentObj = studentMap[a.studentId];
            const roomObj = a.roomId ? roomMap[a.roomId] : null;
            return {
                id: a.id,
                studentId: a.studentId,
                studentName: studentObj?.name ?? `Student ${a.studentId}`,
                studentRoll: studentObj?.rollNumber ?? "—",
                roomId: a.roomId,
                roomNumber: roomObj?.roomNumber ?? "—",
                roomType: roomObj?.type ?? "—",
                monthlyFee: roomObj?.monthlyFee ? Number(roomObj.monthlyFee) : 3000,
                block: roomObj?.block ?? "—",
                hostelName: roomObj?.hostelId ? (hostelMap[roomObj.hostelId] ?? "—") : "—",
                bed: a.bed ?? "—",
                appliedAt: a.appliedAt.toISOString(),
            };
        }));
    } catch (err) {
        req.log.error({ err }, "List hostel allocations error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ── MEALS ──
const ALL_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
router.get("/hostel/meals", requireRole("admin", "hostel_warden", "clerk", "student", "parent"), async (req, res) => {
    try {
        const meals = await db.select().from(hostelMealsTable);
        const sorted = ALL_DAYS.map((day) => meals.find((m) => m.day === day)).filter(Boolean);
        return res.json(sorted);
    }
    catch (err) {
        req.log.error({ err }, "List hostel meals error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.put("/hostel/meals/:day", requireRole("admin", "hostel_warden"), async (req, res) => {
    try {
        const day = String(req.params["day"] ?? "");
        if (!ALL_DAYS.includes(day))
            return res.status(400).json({ error: "Invalid day" });
        const { breakfast, lunch, dinner } = req.body;
        const existing = await db.select().from(hostelMealsTable).where(eq(hostelMealsTable.day, day));
        if (existing.length > 0) {
            const [updated] = await db
                .update(hostelMealsTable)
                .set({ breakfast, lunch, dinner, updatedAt: new Date() })
                .where(eq(hostelMealsTable.day, day))
                .returning();
            return res.json(updated);
        }
        else {
            const [created] = await db
                .insert(hostelMealsTable)
                .values({ day, breakfast, lunch, dinner })
                .returning();
            return res.status(201).json(created);
        }
    }
    catch (err) {
        req.log.error({ err }, "Update hostel meal error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ── NOTICES ──
router.get("/hostel/notices", requireRole("admin", "hostel_warden", "clerk", "student", "parent"), async (req, res) => {
    try {
        const notices = await db.select().from(hostelNoticesTable);
        return res.json(notices.map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })));
    }
    catch (err) {
        req.log.error({ err }, "List hostel notices error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/hostel/notices", requireRole("admin", "hostel_warden"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const { title, body, urgent } = req.body;
        if (!title || !body)
            return res.status(400).json({ error: "title and body are required" });
        const [notice] = await db
            .insert(hostelNoticesTable)
            .values({ title, body, urgent: !!urgent, postedByUserId: req.user.id })
            .returning();
        return res.status(201).json({ ...notice, createdAt: notice.createdAt.toISOString() });
    }
    catch (err) {
        req.log.error({ err }, "Create hostel notice error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.delete("/hostel/notices/:id", requireRole("admin", "hostel_warden"), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        await db.delete(hostelNoticesTable).where(eq(hostelNoticesTable.id, id));
        return res.json({ success: true });
    }
    catch (err) {
        req.log.error({ err }, "Delete hostel notice error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ── HOSTEL ATTENDANCE ──
router.get("/hostel/attendance", requireRole("admin", "hostel_warden"), async (req, res) => {
    try {
        const date = String(req.query.date ?? new Date().toISOString().split("T")[0]);
        const apps = await db.select().from(hostelApplicationsTable).where(eq(hostelApplicationsTable.status, "approved"));
        const students = await db.select().from(studentsTable);
        const studentMap = Object.fromEntries(students.map((s) => [s.id, s]));
        const { eq: eqFn } = await import("drizzle-orm");
        const dayRecords = await db
            .select()
            .from(hostelAttendanceTable)
            .where(eqFn(hostelAttendanceTable.date, date));
        const dayMap = Object.fromEntries(dayRecords.map((r) => [r.studentId, r.status]));
        return res.json({
            date,
            records: apps.map((a) => ({
                studentId: a.studentId,
                studentName: studentMap[a.studentId]?.name ?? `Student ${a.studentId}`,
                rollNumber: studentMap[a.studentId]?.rollNumber ?? null,
                roomId: a.roomId,
                status: dayMap[a.studentId] ?? "in",
            })),
        });
    }
    catch (err) {
        req.log.error({ err }, "Hostel attendance fetch error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/hostel/attendance", requireRole("admin", "hostel_warden"), async (req, res) => {
    try {
        const { date, records } = req.body;
        if (!date || !Array.isArray(records) || records.length === 0)
            return res.status(400).json({ error: "date and attendance records are required" });
        if (records.some((record) => !["in", "out"].includes(record.status)))
            return res.status(400).json({ error: "Hostel attendance status must be in or out" });
        const approvedApplications = await db
            .select()
            .from(hostelApplicationsTable)
            .where(eq(hostelApplicationsTable.status, "approved"));
        const approvedStudentIds = new Set(approvedApplications.map((application) => application.studentId));
        if (records.some((record) => !approvedStudentIds.has(Number(record.studentId))))
            return res.status(400).json({ error: "Attendance can only be marked for approved hostel residents" });
        const { eq: eqFn, and: andFn } = await import("drizzle-orm");
        for (const r of records) {
            const existing = await db
                .select()
                .from(hostelAttendanceTable)
                .where(andFn(eqFn(hostelAttendanceTable.date, date), eqFn(hostelAttendanceTable.studentId, r.studentId)));
            if (existing.length > 0) {
                await db
                    .update(hostelAttendanceTable)
                    .set({ status: r.status })
                    .where(andFn(eqFn(hostelAttendanceTable.date, date), eqFn(hostelAttendanceTable.studentId, r.studentId)));
            }
            else {
                await db.insert(hostelAttendanceTable).values({ date, studentId: r.studentId, status: r.status });
            }
        }
        return res.json({ success: true, count: records.length });
    }
    catch (err) {
        req.log.error({ err }, "Hostel attendance update error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/hostel/attendance/summary", requireRole("admin", "hostel_warden"), async (req, res) => {
    try {
        const { eq: eqFn } = await import("drizzle-orm");
        const days = 7;
        const rows = [];
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date(Date.now() - i * 86400000).toISOString().split("T")[0];
            const recs = await db.select().from(hostelAttendanceTable).where(eqFn(hostelAttendanceTable.date, d));
            rows.push({
                date: d,
                total: recs.length,
                present: recs.filter(r => r.status === "in").length,
                absent: recs.filter(r => r.status === "absent").length,
                out: recs.filter(r => r.status === "out").length,
            });
        }
        return res.json({ summary: rows });
    }
    catch (err) {
        req.log.error({ err }, "Hostel attendance summary error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ── HOSTEL MAINTENANCE LOGS ──
router.get("/hostel/maintenance", requireRole("admin", "hostel_warden", "student", "parent", "clerk"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const students = await db.select().from(studentsTable);
        const rooms = await db.select().from(hostelRoomsTable);
        const studentMap = Object.fromEntries(students.map((s) => [s.id, s.name]));
        const roomMap = Object.fromEntries(rooms.map((r) => [r.id, r.roomNumber]));
        let all = await db.select().from(hostelMaintenanceTable);
        if (me.role === "student" || me.role === "parent") {
            const ownIds = new Set(await resolveOwnStudentIds(me));
            all = all.filter((m) => ownIds.has(m.studentId));
        }
        return res.json(all.map((m) => ({
            ...m,
            studentName: studentMap[m.studentId] ?? `Student ${m.studentId}`,
            roomNumber: roomMap[m.roomId] ?? `Room ${m.roomId}`,
            createdAt: m.createdAt.toISOString()
        })));
    }
    catch (err) {
        req.log.error({ err }, "List hostel maintenance error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/hostel/maintenance", requireRole("admin", "hostel_warden", "student"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const data = req.body;
        let studentId;
        if (me.role === "student") {
            const stud = await resolveStudentForUser(me);
            if (!stud)
                return res.status(403).json({ error: "Student profile not found" });
            studentId = stud.id;
        } else {
            if (!data.studentId)
                return res.status(400).json({ error: "studentId is required" });
            studentId = Number(data.studentId);
        }
        const [app] = await db.select().from(hostelApplicationsTable).where(and(
            eq(hostelApplicationsTable.studentId, studentId),
            eq(hostelApplicationsTable.status, "approved")
        ));
        if (!app || !app.roomId) {
            return res.status(400).json({ error: "No active hostel room assignment found for this student" });
        }
        const [room] = await db.select().from(hostelRoomsTable).where(eq(hostelRoomsTable.id, app.roomId));
        const hostelId = room?.hostelId ?? 1;
        const [log] = await db.insert(hostelMaintenanceTable).values({
            hostelId,
            roomId: app.roomId,
            studentId,
            issueDescription: data.issueDescription,
            category: data.category || "other",
            status: "pending",
        }).returning();
        return res.status(201).json(log);
    }
    catch (err) {
        req.log.error({ err }, "Create maintenance log error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.patch("/hostel/maintenance/:id", requireRole("admin", "hostel_warden"), async (req, res) => {
    try {
        const data = req.body;
        const upd = {};
        if (data.status !== undefined) {
            upd.status = data.status;
            if (data.status === "resolved") {
                upd.resolvedAt = new Date();
            }
        }
        if (data.assignedTo !== undefined) {
            upd.assignedTo = data.assignedTo;
        }
        const [updated] = await db.update(hostelMaintenanceTable).set(upd).where(eq(hostelMaintenanceTable.id, parseInt(String(req.params.id)))).returning();
        if (!updated)
            return res.status(404).json({ error: "Not found" });
        return res.json(updated);
    }
    catch (err) {
        req.log.error({ err }, "Update maintenance log error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ── HOSTEL VISITORS ──
router.get("/hostel/visitors", requireRole("admin", "hostel_warden", "student", "parent", "clerk"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const students = await db.select().from(studentsTable);
        const studentMap = Object.fromEntries(students.map((s) => [s.id, s.name]));
        let all = await db.select().from(hostelVisitorsTable);
        if (me.role === "student" || me.role === "parent") {
            const ownIds = new Set(await resolveOwnStudentIds(me));
            all = all.filter((v) => ownIds.has(v.studentId));
        }
        return res.json(all.map((v) => ({
            ...v,
            studentName: studentMap[v.studentId] ?? `Student ${v.studentId}`
        })));
    }
    catch (err) {
        req.log.error({ err }, "List hostel visitors error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/hostel/visitors", requireRole("admin", "hostel_warden", "student"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const data = req.body;
        let studentId;
        if (me.role === "student") {
            const stud = await resolveStudentForUser(me);
            if (!stud)
                return res.status(403).json({ error: "Student profile not found" });
            studentId = stud.id;
        } else {
            if (!data.studentId)
                return res.status(400).json({ error: "studentId is required" });
            studentId = Number(data.studentId);
        }
        const [app] = await db.select().from(hostelApplicationsTable).where(and(
            eq(hostelApplicationsTable.studentId, studentId),
            eq(hostelApplicationsTable.status, "approved")
        ));
        if (!app || !app.roomId) {
            return res.status(400).json({ error: "No active hostel room assignment found for this student" });
        }
        const [room] = await db.select().from(hostelRoomsTable).where(eq(hostelRoomsTable.id, app.roomId));
        const hostelId = room?.hostelId ?? 1;
        if (!data.idType || !data.idNumber) {
            return res.status(400).json({ error: "ID type and ID number are required" });
        }
        const [visitor] = await db.insert(hostelVisitorsTable).values({
            hostelId,
            studentId,
            visitorName: data.visitorName,
            relationship: data.relationship,
            purpose: data.purpose,
            idType: data.idType ?? null,
            idNumber: data.idNumber ?? null,
            date: data.date || new Date().toISOString().split("T")[0],
            status: "pending",
            checkInTime: data.checkInTime ?? null,
            checkOutTime: data.checkOutTime ?? null,
        }).returning();
        const students = await db.select().from(studentsTable);
        const studentMap = Object.fromEntries(students.map((s) => [s.id, s.name]));
        return res.status(201).json({
            ...visitor,
            studentName: studentMap[visitor.studentId] ?? `Student ${visitor.studentId}`
        });
    }
    catch (err) {
        req.log.error({ err }, "Create visitor log error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.patch("/hostel/visitors/:id", requireRole("admin", "hostel_warden"), async (req, res) => {
    try {
        const data = req.body;
        const upd = {};
        if (data.status !== undefined)
            upd.status = data.status;
        if (data.checkInTime !== undefined)
            upd.checkInTime = data.checkInTime;
        if (data.checkOutTime !== undefined)
            upd.checkOutTime = data.checkOutTime;
        const [updated] = await db.update(hostelVisitorsTable).set(upd).where(eq(hostelVisitorsTable.id, parseInt(String(req.params.id)))).returning();
        if (!updated)
            return res.status(404).json({ error: "Not found" });
        return res.json(updated);
    }
    catch (err) {
        req.log.error({ err }, "Update visitor log error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

export default router;
