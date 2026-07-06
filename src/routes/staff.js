import { Router } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import { Readable } from "node:stream";
import { db } from "@workspace/db";
import {
    staffTable,
    classesTable,
    usersTable,
    staffCheckinsTable,
    staffAttendanceTable,
    schoolSettingsTable,
    studentsTable,
    vendorsTable,
    admissionsTable
} from "@workspace/db";
import { eq, sql, and, or } from "drizzle-orm";
import { requireRole, requireAuth } from "../middlewares/auth";
import { hashPassword } from "../lib/password";
import { ObjectStorageService } from "../lib/objectStorage";
import { sendStaffCredentialsEmail } from "../lib/email";
import { formatClassName } from "../lib/class-format";

const router = Router();
const READ_STAFF = [
    "admin",
    "teacher",
    "clerk",
    "driver",
    "transport_manager",
    "accountant",
    "librarian",
    "hostel_warden",
    "store_manager"
];

const WRITE_STAFF = ["admin"];
const STAFF_CHECKIN_ROLES = [
    "admin",
    "teacher",
    "accountant",
    "clerk",
    "hostel_warden",
    "transport_manager",
    "driver",
    "store_manager",
    "librarian",
];

async function getSchoolTimings() {
    const [settings] = await db.select().from(schoolSettingsTable).where(eq(schoolSettingsTable.id, 1));
    return {
        schoolStartTime: settings?.schoolStartTime ?? "10:00",
        schoolEndTime: settings?.schoolEndTime ?? "17:30",
    };
}

function minutesFromTime(value) {
    const [hour = "0", minute = "0"] = String(value ?? "").split(":");
    return Number(hour) * 60 + Number(minute);
}

function minutesFromDate(date) {
    return date.getHours() * 60 + date.getMinutes();
}
const ROLE_PREFIX = {
    teacher: "TEA",
    admin: "ADM",
    clerk: "CLK",
    accountant: "ACC",
    hostel_warden: "HWN",
    transport_manager: "TRP",
    driver: "DRV",
    store_manager: "STM",
    librarian: "LIB",
};

const FALLBACK_PREFIX = "STF";

function prefixFor(role) {
    return ROLE_PREFIX[role] ?? FALLBACK_PREFIX;
}

function generatePassword() {
    const charset = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    let pwd = "";
    for (let i = 0; i < 8; i++)
        pwd += charset[Math.floor(Math.random() * charset.length)];
    return `${pwd}!`;
}

function slugifyName(name) {
    return String(name).toLowerCase().trim().replace(/\s+/g, ".").replace(/[^a-z0-9.]/g, "") || "staff";
}

function publicDocuments(documents) {
    return (documents ?? []).map(({ dataUrl, ...doc }) => doc);
}

function contentDispositionName(label) {
    return String(label || "document").replace(/["\r\n]/g, "");
}

function sendDataUrlDocument(res, doc) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(doc.dataUrl ?? ""));
    if (!match)
        return false;
    const contentType = match[1] || doc.contentType || "application/octet-stream";
    const isBase64 = !!match[2];
    const raw = match[3] || "";
    const buffer = isBase64 ? Buffer.from(raw, "base64") : Buffer.from(decodeURIComponent(raw));
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("Content-Disposition", `inline; filename="${contentDispositionName(doc.label)}"`);
    res.send(buffer);
    return true;
}

function serializeStaff(s) {
    return { ...s, salary: s.salary ? Number(s.salary) : null, documents: publicDocuments(s.documents) };
}

function serializeClassTeacherAssignment(cls) {
    if (!cls)
        return null;
    return {
        id: cls.id,
        grade: cls.grade,
        section: cls.section,
        name: formatClassName(cls),
        label: formatClassName(cls),
        academicYear: cls.academicYear,
        room: cls.room,
    };
}

async function classTeacherAssignmentsForStaffIds(staffIds) {
    const ids = [...new Set(staffIds.filter((id) => id != null))];
    if (ids.length === 0)
        return new Map();
    const classes = await db.select().from(classesTable);
    const assignmentMap = new Map(ids.map((id) => [String(id), []]));
    for (const cls of classes) {
        const teacherId = cls.teacherId == null ? null : String(cls.teacherId);
        if (!teacherId || !assignmentMap.has(teacherId))
            continue;
        assignmentMap.get(teacherId).push(serializeClassTeacherAssignment(cls));
    }
    return assignmentMap;
}

async function serializeStaffWithClassTeacher(s, assignmentMap) {
    const ownMap = assignmentMap ?? await classTeacherAssignmentsForStaffIds([s.id]);
    const assignments = ownMap.get(String(s.id)) ?? [];
    return {
        ...serializeStaff(s),
        classTeacherAssignments: assignments,
        classTeacherAssignment: assignments[0] ?? null,
    };
}

function summarizeStaffAttendance(records) {
    const counted = records.filter((record) => record.status !== "pending");
    const present = counted.reduce((sum, record) => {
        if (record.status === "present" || record.status === "late")
            return sum + 1;
        if (record.status === "half_day")
            return sum + 0.5;
        return sum;
    }, 0);
    return {
        total: counted.length,
        present,
        absent: counted.length - present,
        percentage: counted.length > 0 ? Math.round((present / counted.length) * 100) : 0,
    };
}

function timeString(date) {
    return date.toTimeString().split(" ")[0];
}

async function findStaffForUser(user) {
    if (!user)
        return null;
    if (user.id) {
        const [byUserId] = await db.select().from(staffTable).where(eq(staffTable.userId, user.id));
        if (byUserId)
            return byUserId;
    }
    if (user.email) {
        const [byEmail] = await db.select().from(staffTable).where(eq(staffTable.email, user.email));
        if (byEmail)
            return byEmail;
    }
    return null;
}

async function syncStaffAttendanceForCheckin(user, date, values) {
    const staff = await findStaffForUser(user);
    if (!staff)
        return null;
    const [existing] = await db.select().from(staffAttendanceTable).where(
        and(
            eq(staffAttendanceTable.staffId, staff.id),
            eq(staffAttendanceTable.date, date)
        )
    );
    const attendanceValues = {
        staffId: staff.id,
        date,
        status: "present",
        remarks: values.remarks ?? "Staff portal check-in",
        ...values,
    };
    if (existing) {
        const [updated] = await db.update(staffAttendanceTable)
            .set(attendanceValues)
            .where(eq(staffAttendanceTable.id, existing.id))
            .returning();
        return updated;
    }
    const [created] = await db.insert(staffAttendanceTable).values(attendanceValues).returning();
    return created;
}

// ─── Helper: Check if email exists in any table ──────────────────────────────
async function checkEmailExists(email, excludeId = null, excludeTable = null) {
    try {
        console.log(`[checkEmailExists] Checking email: ${email}`);

        // Check in users table
        if (excludeTable !== 'users') {
            try {
                const users = await db.select().from(usersTable).where(eq(usersTable.email, email));
                if (users.length > 0) {
                    if (!excludeId || users[0].id !== excludeId) {
                        console.log(`[checkEmailExists] Found in users table`);
                        return { exists: true, table: 'users', tableLabel: 'User' };
                    }
                }
            } catch (err) {
                console.error(`[checkEmailExists] Error checking users table:`, err);
            }
        }

        // Check in staff table
        if (excludeTable !== 'staff') {
            try {
                const staff = await db.select().from(staffTable).where(eq(staffTable.email, email));
                if (staff.length > 0) {
                    if (!excludeId || staff[0].id !== excludeId) {
                        console.log(`[checkEmailExists] Found in staff table`);
                        return { exists: true, table: 'staff', tableLabel: 'Staff Member' };
                    }
                }
            } catch (err) {
                console.error(`[checkEmailExists] Error checking staff table:`, err);
            }
        }

        // Check in students table
        if (excludeTable !== 'students') {
            try {
                const students = await db.select().from(studentsTable).where(eq(studentsTable.email, email));
                if (students.length > 0) {
                    console.log(`[checkEmailExists] Found in students table`);
                    return { exists: true, table: 'students', tableLabel: 'Student' };
                }
            } catch (err) {
                console.error(`[checkEmailExists] Error checking students table:`, err);
            }
        }

        // Check in vendors table
        if (excludeTable !== 'vendors') {
            try {
                const vendors = await db.select().from(vendorsTable).where(eq(vendorsTable.email, email));
                if (vendors.length > 0) {
                    console.log(`[checkEmailExists] Found in vendors table`);
                    return { exists: true, table: 'vendors', tableLabel: 'Vendor' };
                }
            } catch (err) {
                console.error(`[checkEmailExists] Error checking vendors table:`, err);
            }
        }

        // Check in admissions table (parent_email)
        if (excludeTable !== 'admissions') {
            try {
                const admissions = await db.select().from(admissionsTable).where(eq(admissionsTable.parentEmail, email));
                if (admissions.length > 0) {
                    console.log(`[checkEmailExists] Found in admissions table`);
                    return { exists: true, table: 'admissions', tableLabel: 'Admission' };
                }
            } catch (err) {
                console.error(`[checkEmailExists] Error checking admissions table:`, err);
            }
        }

        console.log(`[checkEmailExists] Email not found in any table`);
        return { exists: false };
    } catch (error) {
        console.error("[checkEmailExists] Fatal error:", error);
        return { exists: false };
    }
}

// ── Backfill: assign role-prefixed staff IDs to any existing rows ──────────
export async function ensureStaffIds() {
    const rows = await db.select().from(staffTable);
    const taken = new Set(rows.map((r) => r.staffId).filter((v) => !!v));
    const year = new Date().getFullYear();
    const seqByPrefix = new Map();
    for (const id of taken) {
        const m = /^([A-Z]{3})(\d{4})(\d{3,})$/.exec(id);
        if (!m) continue;
        const [, p, , n] = m;
        const cur = seqByPrefix.get(p) ?? 0;
        seqByPrefix.set(p, Math.max(cur, parseInt(n, 10)));
    }
    for (const row of rows) {
        if (row.staffId) continue;
        const prefix = prefixFor(row.role);
        const next = (seqByPrefix.get(prefix) ?? 0) + 1;
        seqByPrefix.set(prefix, next);
        const newId = `${prefix}${year}${String(next).padStart(3, "0")}`;
        await db.update(staffTable).set({ staffId: newId }).where(eq(staffTable.id, row.id));
    }
}

// ─── POST /api/staff/check-email ─────────────────────────────────────────────
router.post("/staff/check-email", async (req, res) => {
    try {
        const { email, excludeId, excludeTable } = req.body;

        if (!email) {
            return res.status(400).json({
                available: false,
                message: "Email is required"
            });
        }

        console.log(`[Email Check] Checking email: ${email}, excludeId: ${excludeId}, excludeTable: ${excludeTable}`);

        const result = await checkEmailExists(email, excludeId, excludeTable);

        console.log(`[Email Check] Result:`, result);

        if (result.exists) {
            return res.status(200).json({
                available: false,
                message: `Email "${email}" is already registered as a ${result.tableLabel || result.table || 'user'}. Please use a different email.`,
                table: result.table || 'unknown',
                tableLabel: result.tableLabel || result.table || 'user'
            });
        }

        return res.status(200).json({
            available: true,
            message: "Email is available"
        });
    } catch (error) {
        console.error("[Email Check] Error:", error);
        return res.status(500).json({
            available: false,
            message: "Error checking email availability. Please try again."
        });
    }
});

// ─── POST /api/staff ──────────────────────────────────────────────────────────
router.post("/staff", requireRole(...WRITE_STAFF), async (req, res) => {
    try {
        const data = req.body ?? {};

        console.log("[Staff Create] Received data:", JSON.stringify(data, null, 2));

        // Validate required fields including DOB
        const requiredFields = ['name', 'role', 'department', 'email', 'joinDate', 'dob'];
        const missingFields = requiredFields.filter(field => !data[field]);

        if (missingFields.length > 0) {
            console.log("[Staff Create] Missing fields:", missingFields);
            return res.status(400).json({
                error: `Missing required fields: ${missingFields.join(', ')}`
            });
        }

        // ─── Validate DOB ────────────────────────────────────────────────
        try {
            const dobDate = new Date(data.dob);
            if (isNaN(dobDate.getTime())) {
                return res.status(400).json({
                    error: "Invalid date format for DOB"
                });
            }

            const today = new Date();
            const age = today.getFullYear() - dobDate.getFullYear();
            const monthDiff = today.getMonth() - dobDate.getMonth();
            let exactAge = age;
            if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dobDate.getDate())) {
                exactAge -= 1;
            }

            console.log("[Staff Create] Calculated age:", exactAge);

            if (exactAge < 18) {
                return res.status(400).json({
                    error: "Staff must be at least 18 years old"
                });
            }

            if (exactAge > 65) {
                return res.status(400).json({
                    error: "Staff must be under 65 years old"
                });
            }
        } catch (err) {
            console.error("[Staff Create] DOB validation error:", err);
            return res.status(400).json({
                error: "Invalid date of birth format"
            });
        }

        // ─── Check if email already exists ──────────────────────────────
        try {
            const emailCheck = await checkEmailExists(data.email);
            if (emailCheck.exists) {
                console.log("[Staff Create] Email already exists:", data.email);
                return res.status(409).json({
                    error: `Email "${data.email}" is already registered as a ${emailCheck.tableLabel || 'user'}. Please use a different email.`
                });
            }
        } catch (err) {
            console.error("[Staff Create] Email check error:", err);
        }

        const year = new Date().getFullYear();
        const prefix = `${prefixFor(data.role)}${year}`;
        const base = slugifyName(data.name);
        const password = generatePassword();
        const passwordHash = await hashPassword(password);

        console.log("[Staff Create] Generated staff ID prefix:", prefix);
        console.log("[Staff Create] Generated username base:", base);

        let lastErr;
        for (let attempt = 0; attempt < 6; attempt++) {
            try {
                const taken = (await db.select({ staffId: staffTable.staffId }).from(staffTable))
                    .map((r) => r.staffId)
                    .filter((v) => !!v && v.startsWith(prefix))
                    .map((v) => parseInt(v.slice(prefix.length), 10))
                    .filter((n) => !Number.isNaN(n));

                const seq = (taken.length ? Math.max(...taken) : 0) + 1 + attempt;
                const staffId = `${prefix}${String(seq).padStart(3, "0")}`;
                const suffix = staffId.slice(-3);

                let username = `${base}${suffix}`;
                let suffixN = 0;
                while ((await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.username, username))).length > 0) {
                    suffixN += 1;
                    username = `${base}${suffix}${suffixN}`;
                    if (suffixN > 50) {
                        return res.status(500).json({ error: "Could not allocate unique username" });
                    }
                }

                console.log("[Staff Create] Attempting to create staff with ID:", staffId);
                console.log("[Staff Create] Username:", username);

                const { staff, userId } = await db.transaction(async (tx) => {
                    // Insert staff
                    const staffValues = {
                        staffId,
                        name: data.name,
                        role: data.role,
                        department: data.department,
                        email: data.email,
                        phone: data.phone ?? null,
                        dob: data.dob,
                        qualification: data.qualification ?? null,
                        salary: data.salary != null ? String(data.salary) : null,
                        yearsOfExperience: data.yearsOfExperience != null ? Number(data.yearsOfExperience) : null,
                        joinDate: data.joinDate,
                        avatarUrl: data.avatarUrl ?? null,
                        status: "active",
                    };

                    console.log("[Staff Create] Staff values:", JSON.stringify(staffValues, null, 2));

                    const [s] = await tx.insert(staffTable).values(staffValues).returning();
                    console.log("[Staff Create] Staff inserted:", s);

                    // Insert user
                    const userValues = {
                        username,
                        password: passwordHash,
                        role: data.role,
                        name: data.name,
                        email: data.email,
                        phone: data.phone ?? null,
                        avatarUrl: data.avatarUrl ?? null,
                    };

                    console.log("[Staff Create] User values:", JSON.stringify(userValues, null, 2));

                    const [u] = await tx.insert(usersTable).values(userValues).returning();
                    console.log("[Staff Create] User inserted:", u);

                    // Update staff with user ID
                    const [linked] = await tx
                        .update(staffTable)
                        .set({ userId: u.id })
                        .where(eq(staffTable.id, s.id))
                        .returning();

                    return { staff: linked ?? { ...s, userId: u.id }, userId: u.id };
                });

                console.log("[Staff Create] Successfully created staff with ID:", staff.staffId);

                // Send credentials email in the background without blocking the response
                sendStaffCredentialsEmail({
                    to: data.email,
                    name: data.name,
                    staffId: staff.staffId,
                    username,
                    password,
                }).then(() => {
                    console.log(`[Staff Create] Credentials email sent to ${data.email}`);
                }).catch((emailErr) => {
                    console.error(`[Staff Create] Failed to send credentials email to ${data.email}:`, emailErr);
                });

                return res.status(201).json({
                    ...serializeStaff(staff),
                    userId,
                    credentials: { staffId: staff.staffId, username, password },
                });
            } catch (err) {
                const code = err?.code;
                console.error(`[Staff Create] Attempt ${attempt + 1} failed:`, err);
                console.error(`[Staff Create] Error code:`, code);

                if (code === "23505") {
                    lastErr = err;
                    continue;
                }
                throw err;
            }
        }

        console.error("[Staff Create] Exhausted all retries");
        return res.status(409).json({ error: "Could not allocate a unique staff ID. Try again." });
    } catch (err) {
        console.error("[Staff Create] Fatal error:", err);
        console.error("[Staff Create] Stack:", err.stack);
        return res.status(500).json({
            error: "Internal server error",
            details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
});

// ─── GET /api/staff ──────────────────────────────────────────────────────────
router.get("/staff", requireAuth, async (req, res) => {
    try {
        const me = req.user;
        const { role, department, status, search } = req.query;

        let query = db.select().from(staffTable);

        // Role-based filtering
        if (me.role === "admin" || me.role === "clerk") {
            // Admin and clerk see all staff
        } else {
            // Other roles see only themselves
            const myStaff = await db.select().from(staffTable).where(
                or(
                    eq(staffTable.userId, me.id),
                    eq(staffTable.email, me.email)
                )
            );
            if (myStaff.length > 0) {
                const staffId = myStaff[0].id;
                query = db.select().from(staffTable).where(eq(staffTable.id, staffId));
            } else {
                return res.json([]);
            }
        }

        // Apply filters
        if (role) {
            query = query.where(eq(staffTable.role, role));
        }
        if (department) {
            query = query.where(eq(staffTable.department, department));
        }
        if (status) {
            query = query.where(eq(staffTable.status, status));
        }
        if (search) {
            const searchTerm = `%${search}%`;
            query = query.where(
                sql`${staffTable.name} ILIKE ${searchTerm} OR ${staffTable.email} ILIKE ${searchTerm} OR ${staffTable.staffId} ILIKE ${searchTerm}`
            );
        }

        const staff = await query;
        const assignmentMap = await classTeacherAssignmentsForStaffIds(staff.map((s) => s.id));
        return res.json(await Promise.all(staff.map((s) => serializeStaffWithClassTeacher(s, assignmentMap))));
    } catch (err) {
        req.log.error({ err }, "List staff error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ─── GET /api/staff/:id ──────────────────────────────────────────────────────
router.get("/staff/:id", requireAuth, async (req, res) => {
    try {
        const me = req.user;
        const id = parseInt(String(req.params.id));
        const all = await db.select().from(staffTable).where(eq(staffTable.id, id));
        const s = all[0];

        if (!s) return res.status(404).json({ error: "Not found" });

        if (me.role !== "admin" && me.role !== "clerk" && s.userId !== me.id && s.email !== me.email) {
            return res.status(403).json({ error: "Forbidden" });
        }

        return res.json(await serializeStaffWithClassTeacher(s));
    } catch (err) {
        req.log.error({ err }, "Get staff error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ─── PUT /api/staff/:id ──────────────────────────────────────────────────────
router.put("/staff/:id", requireRole(...WRITE_STAFF), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        const data = req.body ?? {};

        const existingStaff = await db.select().from(staffTable).where(eq(staffTable.id, id));
        const staff = existingStaff[0];
        if (!staff) {
            return res.status(404).json({ error: "Staff not found" });
        }

        // ─── Validate DOB if provided ────────────────────────────────────
        if (data.dob) {
            const dobDate = new Date(data.dob);
            const today = new Date();
            const age = today.getFullYear() - dobDate.getFullYear();
            const monthDiff = today.getMonth() - dobDate.getMonth();
            let exactAge = age;
            if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dobDate.getDate())) {
                exactAge -= 1;
            }

            if (exactAge < 18) {
                return res.status(400).json({
                    error: "Staff must be at least 18 years old"
                });
            }

            if (exactAge > 65) {
                return res.status(400).json({
                    error: "Staff must be under 65 years old"
                });
            }
        }

        // ─── Check if email already exists (excluding current staff) ────
        if (data.email && data.email !== staff.email) {
            const emailCheck = await checkEmailExists(data.email, id, 'staff');
            if (emailCheck.exists) {
                return res.status(409).json({
                    error: `Email "${data.email}" is already registered as a ${emailCheck.tableLabel || 'user'}. Please use a different email.`
                });
            }
        }

        const updateData = {};
        if (data.name) updateData.name = data.name;
        if (data.role) updateData.role = data.role;
        if (data.department) updateData.department = data.department;
        if (data.email) updateData.email = data.email;
        if (data.phone !== undefined) updateData.phone = data.phone;
        if (data.dob) updateData.dob = data.dob;
        if (data.qualification !== undefined) updateData.qualification = data.qualification;
        if (data.salary !== undefined) updateData.salary = String(data.salary);
        if (data.yearsOfExperience !== undefined) updateData.yearsOfExperience = Number(data.yearsOfExperience);
        if (data.joinDate) updateData.joinDate = data.joinDate;
        if (data.avatarUrl !== undefined) updateData.avatarUrl = data.avatarUrl;
        if (data.status) updateData.status = data.status;

        const [updatedStaff] = await db
            .update(staffTable)
            .set(updateData)
            .where(eq(staffTable.id, id))
            .returning();
        const userUpdateData = {};
        if (data.name) userUpdateData.name = data.name;
        if (data.email) userUpdateData.email = data.email;
        if (data.phone !== undefined) userUpdateData.phone = data.phone;
        if (data.avatarUrl !== undefined) userUpdateData.avatarUrl = data.avatarUrl;
        if (data.role) userUpdateData.role = data.role;

        if (Object.keys(userUpdateData).length > 0) {
            const userWhere = staff.userId
                ? eq(usersTable.id, staff.userId)
                : eq(usersTable.email, staff.email);
            await db
                .update(usersTable)
                .set(userUpdateData)
                .where(userWhere);




        }

        return res.json(serializeStaff(updatedStaff));
    } catch (err) {
        req.log.error({ err }, "Update staff error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ─── PATCH /api/staff/:id ──────────────────────────────────────────────────────
router.patch("/staff/:id", requireRole(...WRITE_STAFF), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        const data = req.body ?? {};
        const upd = {};

        const [staff] = await db.select().from(staffTable).where(eq(staffTable.id, id));
        if (!staff) return res.status(404).json({ error: "Not found" });

        // ─── Validate DOB if provided ────────────────────────────────────
        if (data.dob) {
            const dobDate = new Date(data.dob);
            const today = new Date();
            const age = today.getFullYear() - dobDate.getFullYear();
            const monthDiff = today.getMonth() - dobDate.getMonth();
            let exactAge = age;
            if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dobDate.getDate())) {
                exactAge -= 1;
            }

            if (exactAge < 18) {
                return res.status(400).json({
                    error: "Staff must be at least 18 years old"
                });
            }

            if (exactAge > 65) {
                return res.status(400).json({
                    error: "Staff must be under 65 years old"
                });
            }
        }

        if (data.email && data.email !== staff.email) {
            const emailCheck = await checkEmailExists(data.email, id, 'staff');
            if (emailCheck.exists) {
                return res.status(409).json({
                    error: `Email "${data.email}" is already registered as a ${emailCheck.tableLabel || 'user'}. Please use a different email.`
                });
            }
        }

        if (data.name !== undefined) upd.name = data.name;
        if (data.role !== undefined) upd.role = data.role;
        if (data.department !== undefined) upd.department = data.department;
        if (data.email !== undefined) upd.email = data.email;
        if (data.phone !== undefined) upd.phone = data.phone;
        if (data.dob !== undefined) upd.dob = data.dob;
        if (data.salary !== undefined) upd.salary = data.salary != null ? String(data.salary) : null;
        if (data.yearsOfExperience !== undefined) upd.yearsOfExperience = data.yearsOfExperience != null ? Number(data.yearsOfExperience) : null;
        if (data.qualification !== undefined) upd.qualification = data.qualification;
        if (data.joinDate !== undefined) upd.joinDate = data.joinDate;
        if (data.status !== undefined) upd.status = data.status;
        if (data.performanceNotes !== undefined) upd.performanceNotes = data.performanceNotes;
        if (data.avatarUrl !== undefined) upd.avatarUrl = data.avatarUrl;

        const [updated] = await db.update(staffTable).set(upd).where(eq(staffTable.id, id)).returning();
        if (!updated) return res.status(404).json({ error: "Not found" });

        const userUpdateData = {};
        if (data.name !== undefined) userUpdateData.name = data.name;
        if (data.email !== undefined) userUpdateData.email = data.email;
        if (data.phone !== undefined) userUpdateData.phone = data.phone;
        if (data.avatarUrl !== undefined) userUpdateData.avatarUrl = data.avatarUrl;
        if (data.role !== undefined) userUpdateData.role = data.role;

        if (Object.keys(userUpdateData).length > 0) {
            const userWhere = staff.userId
                ? eq(usersTable.id, staff.userId)
                : eq(usersTable.email, staff.email);
            await db.update(usersTable).set(userUpdateData).where(userWhere);
        }

        return res.json(serializeStaff(updated));
    } catch (err) {
        req.log.error({ err }, "Update staff error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ─── DELETE /api/staff/:id ──────────────────────────────────────────────────
router.delete("/staff/:id", requireRole(...WRITE_STAFF), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));

        const existingStaff = await db.select().from(staffTable).where(eq(staffTable.id, id));
        const staff = existingStaff[0];
        if (!staff) {
            return res.status(404).json({ error: "Staff not found" });
        }

        await db.transaction(async (tx) => {
            if (staff.userId) {
                await tx.delete(usersTable).where(eq(usersTable.id, staff.userId));
            }
            await tx.delete(staffTable).where(eq(staffTable.id, id));
        });

        return res.status(204).send();
    } catch (err) {
        req.log.error({ err }, "Delete staff error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ─── POST /api/staff/:id/reset-password ────────────────────────────────────
router.post("/staff/:id/reset-password", requireRole("admin"), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));

        const existingStaff = await db.select().from(staffTable).where(eq(staffTable.id, id));
        const staff = existingStaff[0];
        if (!staff) {
            return res.status(404).json({ error: "Staff not found" });
        }

        if (!staff.userId) {
            return res.status(400).json({ error: "Staff has no associated user account" });
        }

        const newPassword = generatePassword();
        const passwordHash = await hashPassword(newPassword);

        await db
            .update(usersTable)
            .set({ password: passwordHash })
            .where(eq(usersTable.id, staff.userId));

        // Send reset email in the background without blocking the response
        sendStaffCredentialsEmail({
            to: staff.email,
            name: staff.name,
            staffId: staff.staffId,
            username: staff.email,
            password: newPassword,
            isReset: true,
        }).catch((emailErr) => {
            req.log.error({ emailErr }, "Failed to send reset password email");
        });

        return res.json({
            success: true,
            message: "Password reset successful. New password sent via email.",
        });
    } catch (err) {
        req.log.error({ err }, "Reset password error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ── Document uploads (multipart) ───────────────────────────────────────────
const docUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

router.post("/staff/:id/documents", requireRole(...WRITE_STAFF), docUpload.single("file"), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        const file = req.file;
        if (!file) {
            res.status(400).json({ error: "No file uploaded (field 'file' required)" });
            return;
        }
        const label = String(req.body?.label ?? file.originalname ?? "Document").slice(0, 200);
        const [existing] = await db.select().from(staffTable).where(eq(staffTable.id, id));
        if (!existing) {
            res.status(404).json({ error: "Staff not found" });
            return;
        }
        const storage = new ObjectStorageService();
        const url = await storage.uploadObjectEntity(file.buffer, file.mimetype, {
            staffId: String(id),
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
            .update(staffTable)
            .set({ documents })
            .where(eq(staffTable.id, id))
            .returning();
        res.status(201).json({ document: publicDocuments([doc])[0], documents: publicDocuments(updated.documents) });
    } catch (err) {
        req.log.error({ err }, "Upload staff document error");
        res.status(500).json({ error: "Failed to upload document" });
    }
});

router.delete("/staff/:id/documents/:docId", requireRole(...WRITE_STAFF), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        const docId = String(req.params.docId);
        const [existing] = await db.select().from(staffTable).where(eq(staffTable.id, id));
        if (!existing) return res.status(404).json({ error: "Staff not found" });
        const documents = (existing.documents ?? []).filter((d) => d.id !== docId);
        const [updated] = await db
            .update(staffTable)
            .set({ documents })
            .where(eq(staffTable.id, id))
            .returning();
        return res.json({ documents: publicDocuments(updated.documents) });
    } catch (err) {
        req.log.error({ err }, "Delete staff document error");
        return res.status(500).json({ error: "Failed to delete document" });
    }
});

// ── Resource-scoped download ──────────────────────────────────────────────────
router.get("/staff/:id/documents/:docId/download",
    requireRole(...READ_STAFF),
    async (req, res) => {

        try {
            const id = parseInt(String(req.params.id));
            const docId = String(req.params.docId);

            const [staff] = await db.select().from(staffTable).where(eq(staffTable.id, id));
            if (!staff) {
                return res.status(404).json({ error: "Staff not found" });
            }

            // Allow users to access their own documents
            const isAdmin = req.user?.role === "admin";
            const isOwnDocument = String(staff.userId) === String(req.user?.id);

            if (!isAdmin && !isOwnDocument) {
                return res.status(403).json({
                    error: "Forbidden",
                    details: "You can only access your own documents"
                });
            }

            const doc = (staff.documents ?? []).find((d) => d.id === docId);
            if (!doc || (!doc.url && !doc.dataUrl)) {
                return res.status(404).json({ error: "Document not found" });
            }

            if (doc.dataUrl && sendDataUrlDocument(res, doc)) {
                return;
            }

            const storage = new ObjectStorageService();
            const file = await storage.getObjectEntityFile(doc.url);
            const response = await storage.downloadObject(file, 0);

            res.status(response.status);
            response.headers.forEach((value, key) => res.setHeader(key, value));
            res.setHeader("Content-Disposition", `inline; filename="${contentDispositionName(doc.label)}"`);

            if (response.body) {
                const nodeStream = Readable.fromWeb(response.body);
                nodeStream.pipe(res);
            } else {
                res.end();
            }
        } catch (err) {
            req.log.error({ err }, "Download staff document error");
            res.status(500).json({ error: "Failed to download document" });
        }
    });

// ─── Payroll Routes ──────────────────────────────────────────────────────────
router.get("/payroll", requireRole("admin", "accountant"), async (req, res) => {
    try {
        const runs = await db.execute(sql`
            SELECT p.*, s.name as "staffName", s."staffId" as "staffIdCode", s.role as "staffRole"
            FROM "payroll_runs" p
            JOIN "staff" s ON p.staff_id = s.id
            ORDER BY p.year DESC, p.month DESC, s.name ASC
        `);
        return res.json(runs.rows);
    } catch (err) {
        req.log.error({ err }, "Get payroll error");
        return res.status(500).json({ error: "Failed to fetch payroll records" });
    }
});

router.post("/payroll/run", requireRole("admin", "accountant"), async (req, res) => {
    try {
        const { month, year } = req.body;
        if (!month || !year) {
            return res.status(400).json({ error: "Missing month or year" });
        }

        const activeStaff = await db.select().from(staffTable).where(eq(staffTable.status, "active"));

        for (const s of activeStaff) {
            const baseSalary = parseFloat(s.salary || "25000");
            const allowances = 1500.00;
            const deductions = 500.00;
            const netSalary = baseSalary + allowances - deductions;

            const existing = await db.execute(sql`
                SELECT id FROM "payroll_runs" 
                WHERE staff_id = ${s.id} AND month = ${month} AND year = ${year}
                LIMIT 1
            `);

            if (existing.rows.length === 0) {
                await db.execute(sql`
                    INSERT INTO "payroll_runs" ("staff_id", "month", "year", "base_salary", "allowances", "deductions", "net_salary", "payment_status")
                    VALUES (${s.id}, ${month}, ${year}, ${baseSalary}, ${allowances}, ${deductions}, ${netSalary}, 'paid')
                `);
            }
        }

        return res.json({ success: true, message: `Payroll successfully run for ${month}/${year}` });
    } catch (err) {
        req.log.error({ err }, "Run payroll error");
        return res.status(500).json({ error: "Failed to process payroll runs" });
    }
});

router.get("/attendance/staff/me", requireRole(...STAFF_CHECKIN_ROLES), async (req, res) => {
    try {
        const staff = await findStaffForUser(req.user);
        if (!staff)
            return res.status(404).json({ error: "Staff profile not found for this user" });

        const month = String(req.query.month || new Date().toISOString().slice(0, 7));
        const manualRows = (await db.select().from(staffAttendanceTable).where(eq(staffAttendanceTable.staffId, staff.id)))
            .filter((record) => String(record.date).startsWith(month));
        const checkinRows = (await db.select().from(staffCheckinsTable).where(eq(staffCheckinsTable.userId, req.user.id)))
            .filter((record) => String(record.date).startsWith(month));

        const recordsByDate = new Map();
        for (const record of manualRows) {
            recordsByDate.set(String(record.date), {
                ...record,
                status: record.status ?? "pending",
                source: "staff_attendance",
            });
        }
        for (const checkin of checkinRows) {
            const date = String(checkin.date);
            const existing = recordsByDate.get(date) ?? {};
            recordsByDate.set(date, {
                ...existing,
                id: existing.id ?? checkin.id,
                staffId: staff.id,
                userId: req.user.id,
                date,
                status: existing.status ?? (checkin.checkInTime ? "present" : "pending"),
                remarks: existing.remarks ?? null,
                checkInTime: checkin.checkInTime ?? existing.checkInTime ?? null,
                checkOutTime: checkin.checkOutTime ?? existing.checkOutTime ?? null,
                checkInReason: checkin.checkInReason ?? null,
                checkOutReason: null,
                source: existing.source ? "merged" : "staff_checkins",
            });
        }

        const records = Array.from(recordsByDate.values())
            .sort((a, b) => String(b.date).localeCompare(String(a.date)));

        return res.json({
            staff: serializeStaff(staff),
            month,
            summary: summarizeStaffAttendance(records),
            records,
        });
    } catch (err) {
        req.log.error({ err }, "Get own staff attendance error");
        res.status(500).json({ error: "Internal server error" });
    }
});

// ─── Check-In / Check-Out Routes ──────────────────────────────────────────────

/**
 * GET /api/attendance/checkin - Get today's check-in record
 */
router.get("/attendance/checkin", requireRole(...STAFF_CHECKIN_ROLES), async (req, res) => {
    try {
        const userId = req.user.id;
        const today = new Date().toISOString().split("T")[0];

        const [record] = await db.select().from(staffCheckinsTable).where(
            and(
                eq(staffCheckinsTable.userId, userId),
                eq(staffCheckinsTable.date, today)
            )
        );

        res.json(record || null);
    } catch (err) {
        req.log.error({ err }, "Get today-checkin error");
        res.status(500).json({ error: "Internal server error" });
    }
});

/**
 * POST /api/attendance/checkin - Check in
 */
router.post("/attendance/checkin", requireRole(...STAFF_CHECKIN_ROLES), async (req, res) => {
    try {
        const { reason } = req.body || {};
        const userId = req.user.id;
        const today = new Date().toISOString().split("T")[0];
        const now = new Date();
        const timings = await getSchoolTimings();
        const isLate = minutesFromDate(now) > minutesFromTime(timings.schoolStartTime);
        const checkInReason = reason?.trim() || (isLate ? "Late check-in" : null);

        const [existing] = await db.select().from(staffCheckinsTable).where(
            and(
                eq(staffCheckinsTable.userId, userId),
                eq(staffCheckinsTable.date, today)
            )
        );

        if (existing) {
            if (existing.checkInTime) {
                return res.status(400).json({
                    error: "You have already checked in today"
                });
            }

            const [updated] = await db.update(staffCheckinsTable)
                .set({
                    checkInTime: now,
                    checkInReason,
                })
                .where(eq(staffCheckinsTable.id, existing.id))
                .returning();

            await syncStaffAttendanceForCheckin(req.user, today, {
                checkInTime: timeString(now),
                remarks: checkInReason || "Staff portal check-in",
            });

            req.log.info({ userId, date: today }, "Staff check-in updated");
            return res.json(updated);
        }

        const [record] = await db.insert(staffCheckinsTable).values({
            userId,
            date: today,
            checkInTime: now,
            checkInReason,
        }).returning();

        await syncStaffAttendanceForCheckin(req.user, today, {
                checkInTime: timeString(now),
                remarks: checkInReason || "Staff portal check-in",
            });

        req.log.info({ userId, date: today, checkInTime: now }, "Staff checked in successfully");
        res.status(201).json(record);
    } catch (err) {
        req.log.error({ err }, "Checkin error");
        res.status(500).json({ error: "Internal server error" });
    }
});

/**
 * POST /api/attendance/checkout - Check out
 */
router.post("/attendance/checkout", requireRole(...STAFF_CHECKIN_ROLES), async (req, res) => {
    try {
        const { reason } = req.body || {};
        const userId = req.user.id;
        const today = new Date().toISOString().split("T")[0];
        const now = new Date();
        const timings = await getSchoolTimings();
        const isEarly = minutesFromDate(now) < minutesFromTime(timings.schoolEndTime);
        const checkOutReason = reason?.trim() || (isEarly ? "Early checkout" : null);

        const [existing] = await db.select().from(staffCheckinsTable).where(
            and(
                eq(staffCheckinsTable.userId, userId),
                eq(staffCheckinsTable.date, today)
            )
        );

        if (!existing) {
            return res.status(400).json({ error: "No check-in record found for today" });
        }
        if (existing.checkOutTime) {
            return res.status(400).json({ error: "You have already checked out today" });
        }

        const [updated] = await db.update(staffCheckinsTable)
            .set({
                checkOutTime: now,
                checkOutReason,
            })
            .where(eq(staffCheckinsTable.id, existing.id))
            .returning();

            await syncStaffAttendanceForCheckin(req.user, today, {
                checkOutTime: timeString(now),
                remarks: checkOutReason || "Staff portal check-out",
            });

        req.log.info({ userId, date: today, checkOutTime: now }, "Staff checked out");
        res.json(updated);
    } catch (err) {
        req.log.error({ err }, "Checkout error");
        res.status(500).json({ error: "Internal server error" });
    }
});

export default router;
