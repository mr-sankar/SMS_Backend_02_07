import { Router } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import { Readable } from "node:stream";
import { db } from "@workspace/db";
import { studentsTable, classesTable, attendanceTable, periodAttendanceTable, usersTable, staffTable } from "@workspace/db";
import { eq, sql, and } from "drizzle-orm";
import { requireRole } from "../middlewares/auth";
import { resolveOwnStudentIds } from "../lib/scope";
import { hashPassword } from "../lib/password";
import { formatClassName } from "../lib/class-format";

import { ObjectStorageService } from "../lib/objectStorage";
function generatePassword() {
    const charset = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    let pwd = "";
    for (let i = 0; i < 8; i++)
        pwd += charset[Math.floor(Math.random() * charset.length)];
    return `${pwd}!`;
}
function slugifyName(name) {
    return String(name).toLowerCase().trim().replace(/\s+/g, ".").replace(/[^a-z0-9.]/g, "") || "student";
}

function normalizeAcademicYear(value) {
    const raw = String(value ?? "").trim();
    const match = raw.match(/^(\d{4})(?:\s*-\s*(\d{4}))?$/);
    if (!match)
        return null;
    const startYear = Number(match[1]);
    if (!Number.isInteger(startYear))
        return null;
    const currentYear = new Date().getFullYear();
    if (startYear < currentYear)
        return null;
    return `${startYear} - ${startYear + 1}`;
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
function getDateScopes(now = new Date()) {
    const iso = now.toISOString();
    return {
        today: iso.slice(0, 10),
        month: iso.slice(0, 7),
    };
}
function summarizeAttendance(records) {
    const countedRecords = records.filter((r) => r.status !== "excused");
    const attendedPeriods = countedRecords.reduce((sum, r) => sum + (r.status === "present" || r.status === "late" ? 1 : r.status === "half_day" ? 0.5 : 0), 0);
    const missedPeriods = countedRecords.length - attendedPeriods;
    const excusedRecords = records.length - countedRecords.length;
    const percentage = countedRecords.length > 0 ? Math.round((attendedPeriods / countedRecords.length) * 100) : 0;
    return {
        totalPeriods: countedRecords.length,
        attendedPeriods,
        missedPeriods,
        excusedPeriods: excusedRecords,
        percentage,
    };
}
function buildAttendanceSnapshot(records, date, month) {
    const dailyRecords = records.filter((r) => String(r.date) === date);
    const monthlyRecords = records.filter((r) => String(r.date).startsWith(month));
    return {
        daily: summarizeAttendance(dailyRecords),
        monthly: summarizeAttendance(monthlyRecords),
        allTime: summarizeAttendance(records),
    };
}

function normalizePhone(phone) {
    const value = String(phone ?? "").trim().replace(/[^0-9+\-\s()]/g, "");
    return value || null;
}
async function allocateUsername(baseName, suffixValue, fallback = "parent") {
    const base = slugifyName(baseName) || fallback;
    const suffix = String(suffixValue ?? "").replace(/\D/g, "").slice(-4) || String(Date.now()).slice(-4);
    let username = `${base}${suffix}`;
    let attempt = 0;
    while ((await db.select().from(usersTable).where(eq(usersTable.username, username))).length > 0) {
        attempt += 1;
        username = `${base}${suffix}${attempt}`;
        if (attempt > 50)
            throw new Error("Could not allocate unique username");
    }
    return username;
}
async function allocateParentId() {
    const year = new Date().getFullYear();
    const prefix = `PAR${year}`;
    const existing = await db.select({ parentId: usersTable.parentId }).from(usersTable);
    const seqNums = existing
        .map((u) => u.parentId)
        .filter((id) => id && id.startsWith(prefix))
        .map((id) => parseInt(id.slice(prefix.length), 10))
        .filter((n) => !Number.isNaN(n));
    const next = (seqNums.length ? Math.max(...seqNums) : 0) + 1;
    return `${prefix}${String(next).padStart(3, "0")}`;
}
const router = Router();
const READ_ROLES = ["admin", "teacher", "clerk", "librarian"];
const WRITE_ROLES = ["admin", "clerk"];
function getDefaultAcademicYear(date = new Date()) {
    const year = date.getFullYear();
    return `${year}-${String(year + 1).slice(-2)}`;
}
function publicDocuments(documents) {
    return (documents ?? []).map(({ dataUrl, ...doc }) => doc);
}
function parseDataUrl(dataUrl) {
    if (typeof dataUrl !== "string")
        return null;
    const match = /^data:([^;,]+)?;base64,(.+)$/s.exec(dataUrl);
    if (!match)
        return null;
    return {
        contentType: match[1] || "application/octet-stream",
        buffer: Buffer.from(match[2], "base64"),
    };
}

router.get("/students", requireRole(...READ_ROLES), async (req, res) => {
    try {
        const { classId, search, status } = req.query;
        const allStudents = await db.select().from(studentsTable);
        const classes = await db.select().from(classesTable);
        const classMap = Object.fromEntries(classes.map((c) => [c.id, formatClassName(c)]));

        let result = allStudents;
        if (req.user?.role === "teacher") {
            const { resolveTeacherClassIds } = await import("../lib/scope");
            const classIds = new Set(await resolveTeacherClassIds(req.user.id));
            result = result.filter((s) => classIds.has(s.classId));
        }
        if (classId)
            result = result.filter((s) => s.classId === parseInt(String(classId)));
        if (status)
            result = result.filter((s) => s.status === String(status));
        if (search) {
            const q = String(search).toLowerCase();
            result = result.filter((s) => s.name.toLowerCase().includes(q) || s.rollNumber.toLowerCase().includes(q));
        }
        const isLibrarian = req.user?.role === "librarian";
        return res.json(result.map((s) => ({
            ...s,
            className: s.classId ? (classMap[s.classId] ?? `Class ${s.classId}`) : "Unassigned",
            lastClassId: s.lastClassId ?? null,
            dateOfBirth: isLibrarian ? null : (s.dateOfBirth ?? null),
            admissionDate: s.admissionDate,
            phone: isLibrarian ? null : s.phone,
            email: isLibrarian ? null : s.email,
            parentName: isLibrarian ? null : s.parentName,
            parentPhone: isLibrarian ? null : s.parentPhone,
            address: isLibrarian ? null : s.address,
            academicYear: s.academicYear ?? null,
            documents: isLibrarian ? [] : publicDocuments(s.documents),
            userId: isLibrarian ? null : s.userId,
        })));
    }
    catch (err) {
        req.log.error({ err }, "List students error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/students", requireRole(...WRITE_ROLES), async (req, res) => {
    try {
        const data = req.body;
        if (!data?.name || !data?.classId || !data?.gender || !data?.admissionDate) {
            return res.status(400).json({ error: "Missing required fields: name, classId, gender, admissionDate" });
        }
        // ── Generate unique student ID: STU{year}{3-digit seq} ─────────────────
        const year = new Date().getFullYear();
        const prefix = `STU${year}`;
        let rollNumber = data.rollNumber?.trim() || "";
        if (!rollNumber) {
            const existing = await db.select({ rollNumber: studentsTable.rollNumber }).from(studentsTable);
            const seqNums = existing
                .map((s) => s.rollNumber)
                .filter((r) => r.startsWith(prefix))
                .map((r) => parseInt(r.slice(prefix.length), 10))
                .filter((n) => !Number.isNaN(n));
            const next = (seqNums.length ? Math.max(...seqNums) : 0) + 1;
            rollNumber = `${prefix}${String(next).padStart(3, "0")}`;
        }
        else {
            const clash = await db.select().from(studentsTable).where(eq(studentsTable.rollNumber, rollNumber));
            if (clash.length > 0)
                return res.status(409).json({ error: "Roll number already in use" });
        }
        // ── Generate unique username + password ────────────────────────────────
        const base = slugifyName(data.name);
        const suffix = rollNumber.slice(-3);
        let username = `${base}${suffix}`;
        let attempt = 0;
        // eslint-disable-next-line no-await-in-loop
        while ((await db.select().from(usersTable).where(eq(usersTable.username, username))).length > 0) {
            attempt += 1;
            username = `${base}${suffix}${attempt}`;
            if (attempt > 50)
                return res.status(500).json({ error: "Could not allocate unique username" });
        }
        const password = generatePassword();
        // ── Hash password before persisting ────────────────────────────────────
        const passwordHash = await hashPassword(password);
        const academicYear = normalizeAcademicYear(data.academicYear) ?? getDefaultAcademicYear();
        // ── Atomic insert: student + user + back-link in one transaction ───────
        const { student, userId } = await db.transaction(async (tx) => {
            const [s] = await tx.insert(studentsTable).values({
                name: data.name,
                rollNumber,
                classId: data.classId,
                gender: data.gender,
                dateOfBirth: data.dateOfBirth ?? null,
                phone: data.phone ?? null,
                email: data.email ?? null,
                parentName: data.parentName ?? null,
                parentPhone: data.parentPhone ?? null,
                address: data.address ?? null,
                academicYear,
                admissionDate: data.admissionDate,
                avatarUrl: data.avatarUrl ?? null,
                status: "active",
            }).returning();
            const [u] = await tx.insert(usersTable).values({
                username,
                password: passwordHash,
                role: "student",
                name: data.name,
                email: data.email || `${username}@student.local`,
                phone: data.phone ?? null,
                avatarUrl: data.avatarUrl ?? null,
            }).returning();
            const [linked] = await tx
                .update(studentsTable)
                .set({ userId: u.id })
                .where(eq(studentsTable.id, s.id))
                .returning();
            return { student: linked ?? { ...s, userId: u.id }, userId: u.id };
        });
        const classes = await db.select().from(classesTable).where(eq(classesTable.id, student.classId));
        const cls = classes[0];
        return res.status(201).json({
            ...student,
            userId,
           className: cls ? formatClassName(cls) : `Class ${student.classId}`,
            // Plaintext password is returned ONCE in the create response; only the
            // bcrypt hash is persisted in users.password.
            credentials: { studentId: rollNumber, username, password },
        });
    }
    catch (err) {
        req.log.error({ err }, "Create student error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/students/parents", requireRole("admin", "clerk"), async (req, res) => {
    try {
        const parents = await db.select().from(usersTable).where(eq(usersTable.role, "parent"));
        const students = await db.select().from(studentsTable);
        const classes = await db.select().from(classesTable);
        const classMap = Object.fromEntries(classes.map((c) => [c.id, formatClassName(c)]));
const result = parents.map((p) => {
            const children = p.phone
                ? students
                    .filter((s) => s.parentPhone && s.parentPhone === p.phone)
                    .map((s) => ({
                        id: s.id,
                        name: s.name,
                        rollNumber: s.rollNumber,
                        class: classMap[s.classId] ?? `Class ${s.classId}`,
                    }))
                : [];
            return {
                id: p.id,
                parentId: p.parentId ?? null,
                name: p.name,
                username: p.username,
                phone: p.phone ?? "",
                email: p.email ?? "",
                address: p.address ?? "",
                avatarUrl: p.avatarUrl ?? null,
                children,
            };
        });
        return res.json(result);
    }
    catch (err) {
        req.log.error({ err }, "List parents mapping error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/students/parents", requireRole("admin", "clerk"), async (req, res) => {
    try {
        const data = req.body ?? {};
        const name = String(data.name ?? "").trim();
        const email = String(data.email ?? "").trim();
        const phone = normalizePhone(data.phone);
        const address = String(data.address ?? "").trim();
        const studentId = data.studentId ? Number(data.studentId) : null;
        if (!name || !email || !phone || !address) {
            return res.status(400).json({ error: "Missing required fields: name, email, phone, address" });
        }
        const parents = await db.select().from(usersTable).where(eq(usersTable.role, "parent"));
        const existingByPhone = parents.find((p) => p.phone === phone);
        if (existingByPhone) {
            return res.status(409).json({
                error: "A parent account already exists with this phone number",
                parent: {
                    id: existingByPhone.id,
                    name: existingByPhone.name,
                    username: existingByPhone.username,
                    parentId: existingByPhone.parentId,
                    phone: existingByPhone.phone,
                    email: existingByPhone.email,
                    address: existingByPhone.address,
                },
            });
        }
        let student = null;
        if (studentId) {
            const [row] = await db.select().from(studentsTable).where(eq(studentsTable.id, studentId));
            if (!row)
                return res.status(404).json({ error: "Student not found" });
            student = row;
        }
        const parentId = await allocateParentId();
        const username = await allocateUsername(name, phone, "parent");
        const password = generatePassword();
        const passwordHash = await hashPassword(password);
        const { parent, linkedStudent } = await db.transaction(async (tx) => {
            const [createdParent] = await tx.insert(usersTable).values({
                parentId,
                username,
                password: passwordHash,
                role: "parent",
                name,
                email,
                phone,
                address,
                avatarUrl: data.avatarUrl ?? null,
            }).returning();
            let updatedStudent = null;
            if (student) {
                [updatedStudent] = await tx
                    .update(studentsTable)
                    .set({ parentName: name, parentPhone: phone })
                    .where(eq(studentsTable.id, student.id))
                    .returning();
            }
            return { parent: createdParent, linkedStudent: updatedStudent };
        });
        return res.status(201).json({
            parent: {
                id: parent.id,
                parentId: parent.parentId,
                name: parent.name,
                username: parent.username,
                email: parent.email,
                phone: parent.phone ?? "",
                address: parent.address ?? "",
            },
            linkedStudent,
            credentials: { parentId: parent.parentId, username, password },
        });
    }
    catch (err) {
        req.log.error({ err }, "Create parent account error");
        return res.status(500).json({ error: err?.message ?? "Internal server error" });
    }
});

router.patch("/students/parents/:id", requireRole("admin", "clerk"), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        const { phone, name, email, address } = req.body ?? {};
        const updateData = {};
        if (phone !== undefined)
            updateData.phone = normalizePhone(phone);
        if (name !== undefined)
            updateData.name = String(name).trim();
        if (email !== undefined)
            updateData.email = String(email).trim();
        if (address !== undefined)
            updateData.address = String(address).trim();
        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ error: "No parent fields supplied" });
        }
        const [updated] = await db
            .update(usersTable)
            .set(updateData)
            .where(eq(usersTable.id, id))
            .returning();
        if (!updated || updated.role !== "parent") {
            return res.status(404).json({ error: "Parent not found" });
        }
        return res.json({ id: updated.id, parentId: updated.parentId ?? null, name: updated.name, username: updated.username, phone: updated.phone ?? "", email: updated.email, address: updated.address ?? "" });
    }
    catch (err) {
        req.log.error({ err }, "Update parent phone error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/students/parents/:id/link", requireRole("admin", "clerk"), async (req, res) => {
    try {
        const parentId = parseInt(String(req.params.id));
        const studentId = Number(req.body?.studentId);
        if (!studentId)
            return res.status(400).json({ error: "studentId is required" });
        const [parent] = await db.select().from(usersTable).where(eq(usersTable.id, parentId));
        if (!parent || parent.role !== "parent")
            return res.status(404).json({ error: "Parent not found" });
        const phone = normalizePhone(req.body?.parentPhone ?? parent.phone);
        if (!phone)
            return res.status(400).json({ error: "Parent phone is required before linking" });
        const parentName = String(req.body?.parentName ?? parent.name).trim();
        const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, studentId));
        if (!student)
            return res.status(404).json({ error: "Student not found" });
        const { updatedParent, updatedStudent } = await db.transaction(async (tx) => {
            const [p] = await tx
                .update(usersTable)
                .set({ phone, name: parentName || parent.name })
                .where(eq(usersTable.id, parentId))
                .returning();
            const [s] = await tx
                .update(studentsTable)
                .set({ parentName: p.name, parentPhone: phone })
                .where(eq(studentsTable.id, studentId))
                .returning();
            return { updatedParent: p, updatedStudent: s };
        });
        return res.json({
            parent: {
                id: updatedParent.id,
                parentId: updatedParent.parentId ?? null,
                name: updatedParent.name,
                username: updatedParent.username,
                phone: updatedParent.phone ?? "",
                email: updatedParent.email,
                address: updatedParent.address ?? "",
            },
            student: updatedStudent,
        });
    }
    catch (err) {
        req.log.error({ err }, "Link parent student error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/students/:id", requireRole(...READ_ROLES, "student", "parent"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const id = parseInt(String(req.params.id));
        // Student/parent may only fetch own / their children's record
        if (me.role === "student" || me.role === "parent") {
            const ownIds = new Set(await resolveOwnStudentIds(me));
            if (!ownIds.has(id))
                return res.status(403).json({ error: "Forbidden" });
        }
        const students = await db.select().from(studentsTable).where(eq(studentsTable.id, id));
        const student = students[0];
        if (!student)
            return res.status(404).json({ error: "Not found" });
        if (me.role === "teacher") {
            const { resolveTeacherClassIds } = await import("../lib/scope");
            const allowed = await resolveTeacherClassIds(me.id);
            if (!allowed.includes(student.classId)) {
                return res.status(403).json({ error: "Forbidden", details: "Teacher not associated with this student's class" });
            }
        }
        const cls = student.classId ? (await db.select().from(classesTable).where(eq(classesTable.id, student.classId)))[0] : null;
        const studentObj = { ...student, className: cls ? formatClassName(cls) : "Unassigned", lastClassId: student.lastClassId ?? null };
        if (me.role === "librarian") {
            studentObj.phone = null;
            studentObj.email = null;
            studentObj.parentName = null;
            studentObj.parentPhone = null;
            studentObj.address = null;
            studentObj.dateOfBirth = null;
            studentObj.documents = [];
            studentObj.userId = null;
        }
        studentObj.documents = publicDocuments(studentObj.documents);
        return res.json(studentObj);
    }
    catch (err) {
        req.log.error({ err }, "Get student error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.patch("/students/:id", requireRole(...WRITE_ROLES), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        const data = req.body;
        const [existing] = await db.select().from(studentsTable).where(eq(studentsTable.id, id));
        if (!existing)
            return res.status(404).json({ error: "Not found" });
        const updateData = {};
        if (data.name !== undefined)
            updateData.name = data.name;
        if (data.classId !== undefined) {
            updateData.classId = data.classId;
            updateData.lastClassId = data.classId ?? existing.classId ?? null;
        }
        if (data.phone !== undefined)
            updateData.phone = data.phone;
        if (data.email !== undefined)
            updateData.email = data.email;
        if (data.parentName !== undefined)
            updateData.parentName = data.parentName;
        if (data.parentPhone !== undefined)
            updateData.parentPhone = data.parentPhone;
        if (data.address !== undefined)
            updateData.address = data.address;
        if (data.academicYear !== undefined) {
            const academicYear = normalizeAcademicYear(data.academicYear);
            if (!academicYear) {
                return res.status(400).json({ error: "Academic year must be a 4-digit year like 2026" });
            }
            updateData.academicYear = academicYear;
        }
        if (data.status !== undefined)
            updateData.status = data.status;
        if (data.avatarUrl !== undefined)
            updateData.avatarUrl = data.avatarUrl;
        if (data.documents !== undefined)
            updateData.documents = data.documents;
        const [updated] = await db.update(studentsTable).set(updateData).where(eq(studentsTable.id, id)).returning();
        if (!updated)
            return res.status(404).json({ error: "Not found" });
        if (updated.userId && data.avatarUrl !== undefined) {
            await db.update(usersTable).set({ avatarUrl: data.avatarUrl }).where(eq(usersTable.id, updated.userId));
        }
        const cls = updated.classId ? (await db.select().from(classesTable).where(eq(classesTable.id, updated.classId)))[0] : null;
       return res.json({ ...updated, className: cls ? formatClassName(cls) : "Unassigned", lastClassId: updated.lastClassId ?? null });
    }
    catch (err) {
        req.log.error({ err }, "Update student error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.delete("/students/:id", requireRole("admin"), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        await db.delete(studentsTable).where(eq(studentsTable.id, id));
        return res.status(204).send();
    }
    catch (err) {
        req.log.error({ err }, "Delete student error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.get("/attendance/student/:studentId/summary", requireRole(...READ_ROLES, "student", "parent"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const studentId = parseInt(String(req.params.studentId));
        if (me.role === "student" || me.role === "parent") {
            const ownIds = new Set(await resolveOwnStudentIds(me));
            if (!ownIds.has(studentId))
                return res.status(403).json({ error: "Forbidden" });
        }
        const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, studentId));
        if (!student)
            return res.status(404).json({ error: "Not found" });
        const [studentClass] = await db.select().from(classesTable).where(eq(classesTable.id, student.classId));
        const isPeriodwise = isPeriodEligibleClass(studentClass);
        const attendanceMode = isPeriodwise ? "periodwise" : "daily";
        const records = isPeriodwise
            ? await db.select().from(periodAttendanceTable).where(and(eq(periodAttendanceTable.studentId, studentId), eq(periodAttendanceTable.classId, student.classId)))
            : await db.select().from(attendanceTable).where(eq(attendanceTable.studentId, studentId));
        const scopes = getDateScopes();
        const { daily, monthly, allTime } = buildAttendanceSnapshot(records, scopes.today, scopes.month);
        return res.json({
            studentId,
            attendanceMode,
            totalDays: monthly.totalPeriods,
            presentDays: monthly.attendedPeriods,
            absentDays: monthly.missedPeriods,
            percentage: monthly.percentage,
            dailyAttendance: {
                date: scopes.today,
                ...daily,
            },
            monthlyAttendance: {
                month: scopes.month,
                ...monthly,
            },
            allTimeAttendance: allTime,
        });
    }
    catch (err) {
        req.log.error({ err }, "Student attendance summary error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ── Student Document uploads (multipart) ───────────────────────────────────────────
const docUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

export async function ensureStudentDocumentDataUrls() {
    const storage = new ObjectStorageService();
    const students = await db.select().from(studentsTable);
    let updatedCount = 0;
    for (const student of students) {
        let changed = false;
        const documents = [];
        for (const doc of student.documents ?? []) {
            if (doc?.dataUrl || !doc?.url) {
                documents.push(doc);
                continue;
            }
            try {
                const file = await storage.getObjectEntityFile(doc.url);
                const response = await storage.downloadObject(file, 0);
                const buffer = Buffer.from(await response.arrayBuffer());
                const contentType = doc.contentType || response.headers.get("content-type") || "application/octet-stream";
                documents.push({
                    ...doc,
                    contentType,
                    size: doc.size ?? buffer.length,
                    dataUrl: `data:${contentType};base64,${buffer.toString("base64")}`,
                });
                changed = true;
            }
            catch {
                documents.push(doc);
            }
        }
        if (changed) {
            await db.update(studentsTable).set({ documents }).where(eq(studentsTable.id, student.id));
            updatedCount += 1;
        }
    }
    return updatedCount;
}


router.post("/students/:id/documents", requireRole(...WRITE_ROLES), docUpload.single("file"), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        const file = req.file;
        if (!file) {
            res.status(400).json({ error: "No file uploaded (field 'file' required)" });
            return;
        }
        const label = String(req.body?.label ?? file.originalname ?? "Document").slice(0, 200);
        const [existing] = await db.select().from(studentsTable).where(eq(studentsTable.id, id));
        if (!existing) {
            res.status(404).json({ error: "Student not found" });
            return;
        }
        const storage = new ObjectStorageService();
        const url = await storage.uploadObjectEntity(file.buffer, file.mimetype, {
            studentId: String(id),
            originalName: file.originalname ?? "",
        });
        const doc = {
            id: randomUUID(),
            label,
            url,
            dataUrl: `data:${file.mimetype};base64,${file.buffer.toString("base64")}`,
            contentType: file.mimetype,
            size: file.size,
            uploadedAt: new Date().toISOString(),
        };
        const documents = [...(existing.documents ?? []), doc];
        const [updated] = await db
            .update(studentsTable)
            .set({ documents })
            .where(eq(studentsTable.id, id))
            .returning();
        res.status(201).json({ document: publicDocuments([doc])[0], documents: publicDocuments(updated.documents) });
    }
    catch (err) {
        req.log.error({ err }, "Upload student document error");
        res.status(500).json({ error: "Failed to upload document" });
    }
});

router.delete("/students/:id/documents/:docId", requireRole(...WRITE_ROLES), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        const docId = String(req.params.docId);
        const [existing] = await db.select().from(studentsTable).where(eq(studentsTable.id, id));
        if (!existing)
            return res.status(404).json({ error: "Student not found" });
        const documents = (existing.documents ?? []).filter((d) => d.id !== docId);
        const [updated] = await db
            .update(studentsTable)
            .set({ documents })
            .where(eq(studentsTable.id, id))
            .returning();
        return res.json({ documents: publicDocuments(updated.documents) });
    }
    catch (err) {
        req.log.error({ err }, "Delete student document error");
        return res.status(500).json({ error: "Failed to delete document" });
    }
});

router.get("/students/:id/documents/:docId/download", requireRole(...READ_ROLES, "student", "parent"), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        const docId = String(req.params.docId);
        
        // Check access scope for students and parents
        if (req.user?.role === "student" || req.user?.role === "parent") {
            const ownIds = new Set(await resolveOwnStudentIds(req.user));
            if (!ownIds.has(id))
                return res.status(403).json({ error: "Forbidden" });
        }
        
        const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, id));
        if (!student) {
            res.status(404).json({ error: "Student not found" });
            return;
        }
        const doc = (student.documents ?? []).find((d) => d.id === docId);
        if (!doc) {
            res.status(404).json({ error: "Document not found" });
            return;
        }
         const dbFile = parseDataUrl(doc.dataUrl);
        if (dbFile) {
            res.setHeader("Content-Type", doc.contentType || dbFile.contentType);
            res.setHeader("Content-Length", String(dbFile.buffer.length));
            res.setHeader("Cache-Control", "private, max-age=0");
            res.setHeader("Content-Disposition", `inline; filename="${doc.label || "document"}"`);
            res.end(dbFile.buffer);
            return;
        }
        const storage = new ObjectStorageService();
        const file = await storage.getObjectEntityFile(doc.url);
        const response = await storage.downloadObject(file, 0);
        res.status(response.status);
        response.headers.forEach((value, key) => res.setHeader(key, value));
        res.setHeader("Content-Disposition", `inline; filename="${doc.label || "document"}"`);
        if (response.body) {
            const nodeStream = Readable.fromWeb(response.body);
            nodeStream.pipe(res);
        }
        else {
            res.end();
        }
    }
    catch (err) {
        req.log.error({ err }, "Download student document error");
        res.status(404).json({ error: "Document not found" });
    }
});


router.post("/students/:id/tc", requireRole("admin", "clerk"), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { reason } = req.body;
        const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, id));
        if (!student) {
            return res.status(404).json({ error: "Student not found" });
        }
        const [updated] = await db.update(studentsTable).set({ status: "transferred" }).where(eq(studentsTable.id, id)).returning();
        
        const action = `Generated Transfer Certificate: ${reason || "Graduated/Withdrawn"}`;
        const promotedBy = req.user?.id || 1;
        await db.execute(sql`
            INSERT INTO "audit_logs" ("user_id", "action", "payload")
            VALUES (${promotedBy}, ${action}, ${JSON.stringify({ studentId: id, studentName: student.name })})
        `);
        
        return res.json({ success: true, student: updated });
    } catch (err) {
        req.log.error({ err }, "TC student error");
        return res.status(500).json({ error: "Failed to generate Transfer Certificate" });
    }
});


// ==================== IMPROVED PROMOTE ROUTE ====================
router.post("/students/:id/promote", requireRole("admin"), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { toClassId, academicYear } = req.body;
        const normalizedAcademicYear = normalizeAcademicYear(academicYear);
        if (!toClassId || !normalizedAcademicYear) {
            return res.status(400).json({ error: "Missing toClassId or academicYear" });
        }
        const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, id));
        if (!student) {
            return res.status(404).json({ error: "Student not found" });
        }
        const fromClassId = student.classId;
        const promotedBy = req.user?.id || 1;
        
        await db.execute(sql`
            INSERT INTO "student_promotions" ("student_id", "from_class_id", "to_class_id", "academic_year", "promoted_by")
            VALUES (${id}, ${fromClassId}, ${toClassId}, ${normalizedAcademicYear}, ${promotedBy})
        `);
        
        const [updated] = await db.update(studentsTable).set({ classId: toClassId }).where(eq(studentsTable.id, id)).returning();
        
        return res.json({ success: true, student: updated });
    } catch (err) {
        req.log.error({ err }, "Promote student error");
        return res.status(500).json({ error: "Failed to promote student" });
    }
});
export default router;
