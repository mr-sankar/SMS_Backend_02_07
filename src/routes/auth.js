import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, studentsTable, staffTable, schoolSettingsTable, vendorsTable } from "@workspace/db";
import { and, eq, or } from "drizzle-orm";
import { requireRole, isStaffAccountInactive } from "../middlewares/auth";
import { hashPassword, verifyPassword, isHashed } from "../lib/password";
import { resolveStudentForUser } from "../lib/scope";
import { sendPasswordChangedEmail } from "../lib/email";

const router = Router();
function parseDocuments(value) {
    if (!value)
        return [];
    if (Array.isArray(value))
        return value;
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return [];
}
function publicDocuments(documents) {
    return parseDocuments(documents).map(({ dataUrl, ...doc }) => doc);
}
function documentAccessUrl(doc) {
     if (typeof doc?.dataUrl === "string")
        return doc.dataUrl;
    const url = doc?.url;
    if (typeof url !== "string")
        return null;
    const match = /^\/objects\/uploads\/([^/]+)$/.exec(url);
    if (match)
        return `/api/uploads/${encodeURIComponent(match[1])}`;
    return url;
}

function sendDataUrlDocument(res, doc) {
    const dataUrl = doc?.dataUrl;
    if (typeof dataUrl !== "string")
        return false;
    const match = /^data:([^;,]+)?;base64,(.+)$/s.exec(dataUrl);
    if (!match)
        return false;
    const buffer = Buffer.from(match[2], "base64");
    res.setHeader("Content-Type", doc.contentType || match[1] || "application/octet-stream");
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("Cache-Control", "private, max-age=0");
    res.setHeader("Content-Disposition", `inline; filename="${doc.label || "document"}"`);
    res.end(buffer);
    return true;
}

// All demo users that should exist
const DEMO_USERS = [
    { username: "admin", password: "admin123", role: "admin", name: "Admin User", email: "admin@nexusacademy.edu" },
    // { username: "teacher", password: "teacher123", role: "teacher", name: "Ravi Shankar", email: "teacher@nexusacademy.edu" },
    // { username: "student", password: "student123", role: "student", name: "Arjun Singh", email: "arjun.singh@student.edu" },
    // { username: "parent", password: "parent123", role: "parent", name: "Vikram Singh", email: "parent@nexusacademy.edu", phone: "9998887777" },
    // { username: "accountant", password: "accountant123", role: "accountant", name: "Meera Accountant", email: "accountant@nexusacademy.edu" },
    // { username: "vendor", password: "vendor123", role: "vendor", name: "Raj Suppliers", email: "vendor@nexusacademy.edu" },
    // { username: "clerk", password: "clerk123", role: "clerk", name: "Priya Clerk", email: "clerk@nexusacademy.edu" },
    // { username: "hostel_warden", password: "hostel_warden123", role: "hostel_warden", name: "Suresh Warden", email: "hostel_warden@nexusacademy.edu" },
    // { username: "transport_manager", password: "transport_manager123", role: "transport_manager", name: "Anand Transport", email: "transport_manager@nexusacademy.edu" },
    // { username: "driver", password: "driver123", role: "driver", name: "Ramesh Driver", email: "driver@nexusacademy.edu" },
    // { username: "store_manager", password: "store_manager123", role: "store_manager", name: "Kavita Store", email: "store_manager@nexusacademy.edu" },
    // { username: "librarian", password: "librarian123", role: "librarian", name: "Sunita Librarian", email: "librarian@nexusacademy.edu" },
];
// Ensure all demo users exist on startup. Passwords are stored as bcrypt
// hashes; legacy plaintext rows are migrated in place by re-hashing.
export async function ensureDemoUsers() {
    for (const u of DEMO_USERS) {
        const existing = await db.select().from(usersTable).where(eq(usersTable.username, u.username));
        if (existing.length === 0) {
            const hashed = await hashPassword(u.password);
            await db.insert(usersTable).values({ ...u, password: hashed });
        }
        else {
            const row = existing[0];
            const needsRehash = !isHashed(row.password) || !(await verifyPassword(u.password, row.password));
            if (needsRehash) {
                const hashed = await hashPassword(u.password);
                await db
                    .update(usersTable)
                    .set({ password: hashed, name: u.name, email: u.email })
                    .where(eq(usersTable.username, u.username));
            }
        }
    }
}
router.post("/auth/login", async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: "Username and password required" });
        }
        const users = await db.select().from(usersTable).where(eq(usersTable.username, username));
        const user = users[0];
        if (!user || !(await verifyPassword(password, user.password))) {
            return res.status(401).json({ error: "Invalid credentials" });
        }
        if (await isStaffAccountInactive(user)) {
            return res.status(403).json({ error: "Your staff account is inactive. Please contact the administrator." });
        }
        // Opportunistic re-hash for legacy plaintext rows
        if (!isHashed(user.password)) {
            const hashed = await hashPassword(password);
            await db.update(usersTable).set({ password: hashed }).where(eq(usersTable.id, user.id));
        }
        const isProd = process.env.NODE_ENV === "production" || process.env.RENDER === "true";
        res.cookie("userId", String(user.id), {
            httpOnly: true,
            signed: true,
            sameSite: isProd ? "none" : "lax",
            secure: isProd,
            maxAge: 86400000
        });
        let studentId = null;
        let children = [];
        if (user.role === "student") {
            const s = await resolveStudentForUser(user);
            if (s) studentId = s.id;
        } else if (user.role === "parent" && user.phone) {
            children = await db.select({ id: studentsTable.id, name: studentsTable.name }).from(studentsTable).where(eq(studentsTable.parentPhone, user.phone));
        }
        console.log(`User ${user.username} logged in successfully`);

        return res.json({
            user: {
                id: user.id,
                username: user.username,
                role: user.role,
                name: user.name,
                email: user.email,
                phone: user.phone ?? null,
                parentId: user.parentId ?? null,
                address: user.address ?? null,
                avatarUrl: user.avatarUrl ?? null,
                createdAt: user.createdAt.toISOString(),
                studentId,
                children,
            },
            token: `token-${user.id}`,
        });
    }
    catch (err) {
        req.log.error({ err }, "Login error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/auth/logout", (_req, res) => {
    const isProd = process.env.NODE_ENV === "production" || process.env.RENDER === "true";
    res.clearCookie("userId", {
        httpOnly: true,
        signed: true,
        sameSite: isProd ? "none" : "lax",
        secure: isProd
    });
    return res.json({ success: true });
});
router.get("/auth/me", async (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const users = await db.select().from(usersTable).where(eq(usersTable.id, req.user.id));
        const user = users[0];
        if (!user)
            return res.status(401).json({ error: "Not authenticated" });
        let studentId = null;
        let children = [];
        if (user.role === "student") {
            const s = await resolveStudentForUser(user);
            if (s) studentId = s.id;
        } else if (user.role === "parent" && user.phone) {
            children = await db.select({ id: studentsTable.id, name: studentsTable.name }).from(studentsTable).where(eq(studentsTable.parentPhone, user.phone));
        }
        return res.json({
            id: user.id,
            username: user.username,
            role: user.role,
            name: user.name,
            email: user.email,
            phone: user.phone ?? null,
            avatarUrl: user.avatarUrl ?? null,
            createdAt: user.createdAt.toISOString(),
            studentId,
            children,
        });
    }
    catch (err) {
        req.log.error({ err }, "Get current user error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/school-settings", async (req, res) => {
    try {
        const [settings] = await db.select().from(schoolSettingsTable).where(eq(schoolSettingsTable.id, 1));
        return res.json({
            name: settings?.name ?? "Nexus Academy",
            logoUrl: settings?.logoUrl ?? "",
            schoolStartTime: settings?.schoolStartTime ?? "10:00",
            schoolEndTime: settings?.schoolEndTime ?? "17:30",
            updatedAt: settings?.updatedAt?.toISOString?.() ?? null,
        });
    } catch (err) {
        req.log.error({ err }, "Get school settings error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

function normalizeSchoolTime(value) {
    if (typeof value !== "string")
        return null;
    const match = value.trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    return match ? `${match[1]}:${match[2]}` : null;
}

router.patch("/school-settings", requireRole("admin"), async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Not authenticated" });
        }
        const [existing] = await db.select().from(schoolSettingsTable).where(eq(schoolSettingsTable.id, 1));
        const name = String(req.body?.name ?? existing?.name ?? "Nexus Academy").trim();
        const logoUrl = Object.prototype.hasOwnProperty.call(req.body ?? {}, "logoUrl")
            ? (typeof req.body?.logoUrl === "string" ? req.body.logoUrl : null)
            : (existing?.logoUrl ?? null);
        const schoolStartTime = Object.prototype.hasOwnProperty.call(req.body ?? {}, "schoolStartTime")
            ? normalizeSchoolTime(req.body?.schoolStartTime)
            : (existing?.schoolStartTime ?? "10:00");
        const schoolEndTime = Object.prototype.hasOwnProperty.call(req.body ?? {}, "schoolEndTime")
            ? normalizeSchoolTime(req.body?.schoolEndTime)
            : (existing?.schoolEndTime ?? "17:30");
        if (!name) {
            return res.status(400).json({ error: "School name is required" });
        }
        if (!schoolStartTime || !schoolEndTime) {
            return res.status(400).json({ error: "School start and end timings must use HH:MM format" });
        }
        if (schoolStartTime >= schoolEndTime) {
            return res.status(400).json({ error: "School end time must be later than start time" });
        }
        const [updated] = await db
            .insert(schoolSettingsTable)
            .values({ id: 1, name, logoUrl, schoolStartTime, schoolEndTime })
            .onConflictDoUpdate({
                target: schoolSettingsTable.id,
                set: { name, logoUrl, schoolStartTime, schoolEndTime, updatedAt: new Date() },
            })
            .returning();
        return res.json({
            name: updated.name,
            logoUrl: updated.logoUrl ?? "",
            schoolStartTime: updated.schoolStartTime ?? "10:00",
            schoolEndTime: updated.schoolEndTime ?? "17:30",
            updatedAt: updated.updatedAt.toISOString(),
        });
    } catch (err) {
        req.log.error({ err }, "Update school settings error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// Public self-registration (student / parent roles only)
router.post("/auth/signup", async (req, res) => {
    try {
        const { username, password, name, email, role } = req.body;
        if (!username || !password || !name || !email) {
            return res.status(400).json({ error: "All fields are required" });
        }
        const allowedRoles = ["student", "parent"];
        const userRole = allowedRoles.includes(role) ? role : "student";
        const existing = await db.select().from(usersTable).where(eq(usersTable.username, username));
        if (existing.length > 0) {
            return res.status(409).json({ error: "Username already taken" });
        }
        const hashed = await hashPassword(password);
        await db
            .insert(usersTable)
            .values({ username, password: hashed, role: userRole, name, email })
            .returning();
        return res.status(201).json({
            message: "Registration submitted. Your account is pending admin approval.",
        });
    }
    catch (err) {
        req.log.error({ err }, "Signup error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// Create a new user (admin only in production; here used for student/staff credential generation)
router.post("/auth/users", requireRole("admin", "clerk"), async (req, res) => {
    try {
        const { username, password, role, name, email, phone } = req.body;
        if (!username || !password || !role || !name || !email) {
            return res.status(400).json({ error: "Missing required fields" });
        }
        const existing = await db.select().from(usersTable).where(eq(usersTable.username, username));
        if (existing.length > 0) {
            return res.status(409).json({ error: "Username already exists" });
        }
        const hashed = await hashPassword(password);
        const [user] = await db.insert(usersTable).values({ username, password: hashed, role, name, email, phone: phone ?? null }).returning();
        return res.status(201).json({ id: user.id, username: user.username, role: user.role, name: user.name, email: user.email });
    }
    catch (err) {
        req.log.error({ err }, "Create user error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.patch("/auth/profile", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Not authenticated" });
        }

        const { avatarUrl } = req.body;
        if (avatarUrl === undefined) {
            return res.status(400).json({ error: "avatarUrl is required" });
        }

        const newAvatar = avatarUrl || null;

        // 1. Update main users table (works for everyone including Admin)
        const [updatedUser] = await db
            .update(usersTable)
            .set({ avatarUrl: newAvatar })
            .where(eq(usersTable.id, req.user.id))
            .returning();

        if (!updatedUser) {
            return res.status(404).json({ error: "User not found" });
        }

        // 2. Sync avatar to related tables

        // A. Student table (if applicable)
        if (updatedUser.role === "student") {
            await db
                .update(studentsTable)
                .set({ avatarUrl: newAvatar })
       .where(or(eq(studentsTable.userId, req.user.id), eq(studentsTable.email, updatedUser.email)));
    
    
    }

        // B. Staff table — Now includes Admin + all other staff roles
        // We update staff table for everyone except parent & vendor
        if (!["parent", "vendor"].includes(updatedUser.role)) {
            await db
                .update(staffTable)
                .set({ avatarUrl: newAvatar })
      .where(or(eq(staffTable.userId, req.user.id), eq(staffTable.email, updatedUser.email)));
    
    
    }

        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

        return res.json({
            id: updatedUser.id,
            username: updatedUser.username,
            role: updatedUser.role,
            name: updatedUser.name,
            email: updatedUser.email,
            phone: updatedUser.phone ?? null,
            avatarUrl: updatedUser.avatarUrl,
            createdAt: updatedUser.createdAt.toISOString()
        });
    } catch (err) {
        req.log.error({ err }, "Update profile error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/documents/:id/download", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "Document ID required" });

    // Search in students
    const students = await db.select().from(studentsTable);
    for (const student of students) {
      const docs = parseDocuments(student.documents);
      const doc = docs.find(d => d.id === id);
      if (sendDataUrlDocument(res, doc)) {
        return;
      }

      const url = documentAccessUrl(doc);
      if (url) {
        return res.redirect(url);
      }
    }

    // Search in staff (includes admin etc.)
    const staffMembers = await db.select().from(staffTable);
    for (const member of staffMembers) {
      const docs = parseDocuments(member.documents);
      const doc = docs.find(d => d.id === id);
      if (sendDataUrlDocument(res, doc)) {
        return;
      }

      const url = documentAccessUrl(doc);
      if (url) {
        return res.redirect(url);
      }
    }

    // Search in vendors
    const vendors = await db.select().from(vendorsTable);
    for (const vendor of vendors) {
      const docs = parseDocuments(vendor.documents);
      const doc = docs.find(d => d.id === id);
      const url = documentAccessUrl(doc);
      if (url) {
        return res.redirect(url);
      }
    }

    return res.status(404).json({ error: "Document not found" });
  } catch (err) {
    req.log?.error?.({ err }, "Document download error");
    return res.status(500).json({ error: "Failed to retrieve document" });
  }
});

router.get("/auth/documents", async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const me = req.user;
    const docs = [];

    if (me.role === "student") {
      const student = await resolveStudentForUser(me);

      if (student?.documents?.length) {
        docs.push(...publicDocuments(student.documents).map((doc) => ({
          ...doc,
          source: "student",
          ownerId: student.id,
        })));
      }
    }

    const [staff] = await db.select().from(staffTable).where(
      or(eq(staffTable.userId, me.id), eq(staffTable.email, me.email))
    );
    if (staff?.documents?.length) {
      docs.push(...publicDocuments(staff.documents).map((doc) => ({
        ...doc,
        source: "staff",
        ownerId: staff.id,
      })));
    }

    if (me.role === "vendor") {
      const [vendorRow] = await db.select().from(vendorsTable).where(
        or(eq(vendorsTable.userId, me.id), eq(vendorsTable.email, me.email))
      );

      if (me.role === "vendor" && !staff) {
      const [vendorRow] = await db.select().from(vendorsTable).where(
        or(eq(vendorsTable.userId, me.id), eq(vendorsTable.email, me.email))
      );
      if (vendorRow?.documents?.length) {
        docs.push(...publicDocuments(vendorRow.documents).map((doc) => ({
          ...doc,
          source: "vendor",
          ownerId: vendorRow.id,
        })));
      }
    }

     if (vendorRow?.documents?.length) {
        docs.push(...publicDocuments(vendorRow.documents).map((doc) => ({
          ...doc,
          source: "vendor",
          ownerId: vendorRow.id,
        })));
      }
    }

    return res.json(docs);
  } catch (err) {
    req.log.error({ err }, "List current user documents error");
    return res.status(500).json({ error: "Internal server error" });
  }
});


// Change password endpoint
router.post("/auth/change-password", async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { newPassword } = req.body;
    
    if (!newPassword) {
      return res.status(400).json({ error: "New password is required" });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters long" });
    }

    // Fetch current user
    const users = await db.select().from(usersTable).where(eq(usersTable.id, req.user.id));
    const user = users[0];

    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    // Hash and update new password
    const hashed = await hashPassword(newPassword);
    await db
      .update(usersTable)
      .set({ password: hashed })
      .where(eq(usersTable.id, req.user.id));

    // Send email to user
    if (user.email) {
      sendPasswordChangedEmail({
        to: user.email,
        name: user.name || user.username,
        username: user.username,
        newPassword: newPassword,
      }).catch((emailErr) => {
        req.log.error({ emailErr }, "Failed to send password changed email");
      });
    }

    return res.json({ success: true, message: "Password changed successfully" });
  } catch (err) {
    req.log.error({ err }, "Change password error");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Admin endpoint - change any user's password
router.post("/auth/admin/change-user-password", requireRole("admin", "clerk"), async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { userId, newPassword } = req.body;
    console.log("🔐 Admin password change request:", { userId, passwordLength: newPassword?.length });
    
    if (!userId || !newPassword) {
      return res.status(400).json({ error: "User ID and new password are required" });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters long" });
    }

    // Fetch the user to update
    const users = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    const targetUser = users[0];
    console.log("👤 Target user found:", { id: targetUser?.id, username: targetUser?.username });

    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    // Hash and update new password
    const hashed = await hashPassword(newPassword);
    console.log("🔒 Password hashed, updating database...");
    
    const [updatedUser] = await db
      .update(usersTable)
      .set({ password: hashed })
      .where(eq(usersTable.id, userId))
      .returning();

    console.log("✅ Password updated successfully for user:", { id: updatedUser?.id, username: updatedUser?.username });

    return res.json({ 
      success: true, 
      message: "Password changed successfully",
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        name: updatedUser.name,
        email: updatedUser.email
      }
    });
  } catch (err) {
    console.error("❌ Admin password change error:", err);
    req.log.error({ err }, "Admin change user password error");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Admin endpoint - get user's password (read-only, for display purposes)
router.get("/auth/admin/user/:userId/password-hint", requireRole("admin", "clerk"), async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { userId } = req.params;
    
    const users = await db.select().from(usersTable).where(eq(usersTable.id, parseInt(userId)));
    const targetUser = users[0];

    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json({ 
      userId: targetUser.id,
      username: targetUser.username,
      name: targetUser.name,
      hasPassword: !!targetUser.password
    });
  } catch (err) {
    req.log.error({ err }, "Get user password hint error");
    return res.status(500).json({ error: "Internal server error" });
  }
});


export default router;
