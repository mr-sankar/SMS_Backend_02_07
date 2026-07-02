import { Router } from "express";
import { db } from "@workspace/db";
import { leaveRequestsTable, studentsTable, staffTable, usersTable, classesTable, complaintsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { requireRole } from "../middlewares/auth";
import { resolveStudentForUser, resolveChildrenForParent } from "../lib/scope";
const router = Router();
// Roles permitted to approve/reject leaves. Keep approval centralized so
// operational roles cannot act on unrelated leave requests.
const APPROVER_ROLES = ["admin", "teacher"];
const LEAVE_ROLES = ["admin", "teacher", "clerk", "student", "parent", "hostel_warden", "accountant", "transport_manager", "store_manager", "librarian","driver"];
const APPLY_ROLES = ["admin", "teacher", "clerk", "student", "hostel_warden", "accountant", "transport_manager", "store_manager", "librarian","driver"];





// Roles that can view complaints
const VIEW_ROLES = ["admin", "teacher", "clerk", "hostel_warden", "transport_manager", "store_manager", "librarian", "accountant"];
// Roles that can create complaints
const CREATE_ROLES = ["admin", "teacher", "student", "parent", "clerk", "hostel_warden", "transport_manager", "store_manager", "librarian", "accountant", "vendor", "driver"];


// Roles that can update complaint status
const UPDATE_ROLES = ["admin", "teacher", "hostel_warden", "transport_manager", "store_manager", "librarian", "accountant", "clerk"];

function todayDateString() {
    return new Date().toISOString().split("T")[0];
}
function isPastDate(value) {
    return String(value) < todayDateString();
}
router.get("/leaves", requireRole(...LEAVE_ROLES), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const { status, applicantType } = req.query;
        const role = req.user.role;
        const me = req.user;
        const students = await db.select().from(studentsTable);
        const staff = await db.select().from(staffTable);
        const classes = await db.select().from(classesTable);
        const studentMap = Object.fromEntries(students.map((s) => [s.id, s]));
        const staffMap = Object.fromEntries(staff.map((s) => [s.id, s]));
        let all = await db
            .select()
            .from(leaveRequestsTable)
            .orderBy(desc(leaveRequestsTable.createdAt), desc(leaveRequestsTable.id));
        // ── ROLE-BASED SCOPING ──
        if (role === "admin") {
            // Admin panel handles staff leave requests only.
            all = all.filter((l) => l.applicantType === "staff");
        }
        else if (role === "teacher") {
            const myStaff = staff.find((s) => s.userId === me.id || s.email === me.email);
            const teacherClassIds = new Set();
            if (myStaff) {
                const teacherClasses = classes.filter((c) => c.teacherId === myStaff.id);
                teacherClasses.forEach(c => teacherClassIds.add(c.id));
            }
            all = all.filter((l) => {
                if (l.applicantType === "staff" && myStaff && l.applicantId === myStaff.id) {
                    return true;
                }
                if (l.applicantType === "student") {
                    const studentObj = studentMap[l.applicantId];
                    return studentObj && teacherClassIds.has(studentObj.classId);
                }
                return false;
            });
        }
        else if (role === "student") {
            const myStudent = await resolveStudentForUser(me);
            all = all.filter((l) => l.applicantType === "student" && myStudent && l.applicantId === myStudent.id);
        }
        else if (role === "parent") {
            // parent sees only their own children's leaves
            const myChildren = await resolveChildrenForParent(me);
            const childIds = new Set(myChildren.map((c) => c.id));
            all = all.filter((l) => l.applicantType === "student" && childIds.has(l.applicantId));
        }
        else {
            // clerk, warden, accountant, transport_manager, store_manager, librarian, etc.
            // → ONLY see their own leaves
            const myStaff = staff.find((s) => s.userId === me.id || s.email === me.email);
            all = all.filter((l) => l.applicantType === "staff" && myStaff && l.applicantId === myStaff.id);
        }
        if (status)
            all = all.filter((l) => l.status === String(status));
        if (applicantType)
            all = all.filter((l) => l.applicantType === String(applicantType));
        return res.json(all.map((l) => ({
            ...l,
            applicantName: l.applicantType === "student"
                ? (studentMap[l.applicantId]?.name ?? `Student ${l.applicantId}`)
                : (staffMap[l.applicantId]?.name ?? `Staff ${l.applicantId}`),
            createdAt: l.createdAt.toISOString(),
        })));
    }
    catch (err) {
        req.log.error({ err }, "List leaves error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/leaves", requireRole(...APPLY_ROLES), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const data = req.body;
        if (!data.startDate || !data.endDate)
            return res.status(400).json({ error: "Start date and end date are required" });
        if (isPastDate(data.startDate) || isPastDate(data.endDate))
            return res.status(400).json({ error: "Leave requests for previous dates are not allowed" });
        if (String(data.endDate) < String(data.startDate))
            return res.status(400).json({ error: "End date cannot be before start date" });
        // ── SERVER-DETERMINED APPLICANT (ignore client claims) ──
        let applicantType;
        let applicantId;
        if (me.role === "student") {
            const myStudent = await resolveStudentForUser(me);
            if (!myStudent)
                return res.status(403).json({ error: "Student record not found" });
            applicantType = "student";
            applicantId = myStudent.id;
        }
        else if (me.role === "parent") {
            // Parent applies on behalf of their child
            const myChildren = await resolveChildrenForParent(me);
            const child = data.applicantId ? myChildren.find((c) => c.id === data.applicantId) : myChildren[0];
            if (!child)
                return res.status(403).json({ error: "No child record found" });
            applicantType = "student";
            applicantId = child.id;
        }
        else if (me.role === "admin") {
            // admin can apply for anyone
            applicantType = data.applicantType ?? "staff";
            applicantId = data.applicantId;
        }
        else {
            // staff roles (teacher, clerk, accountant, warden, etc) — leave is for self
            const staff = await db.select().from(staffTable);
            const myStaff = staff.find((s) => s.userId === me.id || s.email === me.email);
            if (!myStaff) {
                // fallback: synthesise a staff entry from the user record so leaves still work
                const [created] = await db.insert(staffTable).values({
                    name: me.name,
                    role: me.role,
                    department: me.role,
                    email: me.email,
                    phone: me.phone,
                    joinDate: new Date().toISOString().split("T")[0],
                    userId: me.id,
                }).returning();
                applicantType = "staff";
                applicantId = created.id;
            }
            else {
                applicantType = "staff";
                applicantId = myStaff.id;
            }
        }
        const [leave] = await db.insert(leaveRequestsTable).values({
            applicantId,
            applicantType,
            leaveType: data.leaveType,
            startDate: data.startDate,
            endDate: data.endDate,
            reason: data.reason,
            status: "pending",
        }).returning();
        const students = await db.select().from(studentsTable);
        const staff = await db.select().from(staffTable);
        const studentMap = Object.fromEntries(students.map((s) => [s.id, s.name]));
        const staffMap = Object.fromEntries(staff.map((s) => [s.id, s.name]));
        return res.status(201).json({
            ...leave,
            applicantName: leave.applicantType === "student"
                ? (studentMap[leave.applicantId] ?? `Student ${leave.applicantId}`)
                : (staffMap[leave.applicantId] ?? `Staff ${leave.applicantId}`),
            createdAt: leave.createdAt.toISOString(),
        });
    }
    catch (err) {
        req.log.error({ err }, "Create leave error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.patch("/leaves/:id", requireRole(...APPROVER_ROLES), async (req, res) => {
    try {
        const me = req.user;
        const data = req.body;
        const id = parseInt(String(req.params.id));
        const existing = await db.select().from(leaveRequestsTable).where(eq(leaveRequestsTable.id, id));
        const cur = existing[0];
        if (!cur)
            return res.status(404).json({ error: "Not found" });
        if ((data.status === "approved" || data.status === "rejected") && (isPastDate(cur.startDate) || isPastDate(cur.endDate))) {
            return res.status(400).json({ error: "Leave requests for previous dates cannot be approved or rejected" });
        }
        if (me.role === "teacher") {
            if (cur.applicantType !== "student") {
                return res.status(403).json({ error: "Teachers can only approve or reject student leave requests" });
            }
            const studentObj = (await db.select().from(studentsTable).where(eq(studentsTable.id, cur.applicantId)))[0];
            if (!studentObj) {
                return res.status(404).json({ error: "Student not found" });
            }
            const staff = await db.select().from(staffTable);
            const myStaff = staff.find((s) => s.userId === me.id || s.email === me.email);
            if (!myStaff) {
                return res.status(403).json({ error: "Staff record not found" });
            }
            const classes = await db.select().from(classesTable);
            const cls = classes.find((c) => c.id === studentObj.classId);
            if (!cls || cls.teacherId !== myStaff.id) {
                return res.status(403).json({ error: "You are not the class teacher for this student" });
            }
            if (data.status !== "approved" && data.status !== "rejected") {
                return res.status(400).json({ error: "Teachers can only approve or reject student leave requests" });
            }
        } else if (me.role === "admin") {
            if (cur.applicantType !== "staff") {
                return res.status(403).json({ error: "Admins can only approve or reject staff leave requests" });
            }
            if (data.status !== "approved" && data.status !== "rejected") {
                return res.status(400).json({ error: "Admins can only approve or reject staff leave requests" });
            }
        } else {
            return res.status(403).json({ error: "Only admin can approve or reject leave requests" });
        }
        const upd = {};
        if (data.status !== undefined)
            upd.status = data.status;
        if (data.remarks !== undefined)
            upd.remarks = data.remarks;
        const [updated] = await db.update(leaveRequestsTable).set(upd).where(eq(leaveRequestsTable.id, id)).returning();
        const studentName = updated.applicantType === "student"
            ? (await db.select().from(studentsTable).where(eq(studentsTable.id, updated.applicantId)))[0]?.name
            : (await db.select().from(staffTable).where(eq(staffTable.id, updated.applicantId)))[0]?.name;
        return res.json({ ...updated, applicantName: studentName ?? `Applicant ${updated.applicantId}`, createdAt: updated.createdAt.toISOString() });
    }
    catch (err) {
        req.log.error({ err }, "Update leave error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// expose roles that can approve to client (used by frontend to hide buttons)
router.get("/leaves/_meta", requireRole(...LEAVE_ROLES), (req, res) => {
    return res.json({ approverRoles: APPROVER_ROLES });
});





router.get("/complaints", requireRole(...VIEW_ROLES), async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Not authenticated" });
        
        const { status, category, priority } = req.query;
        const role = req.user.role;
        const me = req.user;

        // Get all complaints with user info
        let all = await db.select().from(complaintsTable).orderBy(desc(complaintsTable.createdAt));

        // ── ROLE-BASED SCOPING ──
        if (role === "admin") {
            // Admin sees all complaints
            // No filtering needed
        } 
        else if (role === "teacher" || role === "clerk" || role === "accountant" || 
                 role === "hostel_warden" || role === "transport_manager" || 
                 role === "store_manager" || role === "librarian") {
            // Staff roles see complaints related to their department + their own
            const staff = await db.select().from(staffTable);
            const myStaff = staff.find(s => s.userId === me.id || s.email === me.email);
            
            all = all.filter(c => {
                // User's own complaints
                if (c.complainantId === me.id && c.complainantType === "user") return true;
                // Staff's own complaints (if they have staff record)
                if (myStaff && c.complainantId === myStaff.id && c.complainantType === "staff") return true;
                // Department-specific filtering
                if (role === "teacher" && c.category === "academic") return true;
                if (role === "hostel_warden" && c.category === "hostel") return true;
                if (role === "transport_manager" && c.category === "transport") return true;
                if (role === "store_manager" && c.category === "inventory") return true;
                if (role === "librarian" && c.category === "library") return true;
                if (role === "accountant" && c.category === "finance") return true;
                if (role === "clerk") return true; // Clerk sees all general complaints
                return false;
            });
        }
        else if (role === "student") {
            // Student sees only their own complaints
            const myStudent = await resolveStudentForUser(me);
            all = all.filter(c => 
                c.complainantType === "student" && 
                myStudent && 
                c.complainantId === myStudent.id
            );
        }
        else if (role === "parent") {
            // Parent sees complaints from their children
            const myChildren = await resolveChildrenForParent(me);
            const childIds = new Set(myChildren.map(c => c.id));
            all = all.filter(c => 
                c.complainantType === "student" && 
                childIds.has(c.complainantId)
            );
        }
        else if (role === "vendor" || role === "driver") {
            // Vendor/Driver sees their own complaints
            const staff = await db.select().from(staffTable);
            const myStaff = staff.find(s => s.userId === me.id || s.email === me.email);
            all = all.filter(c => {
                if (c.complainantId === me.id && c.complainantType === "user") return true;
                if (myStaff && c.complainantId === myStaff.id && c.complainantType === "staff") return true;
                return false;
            });
        }

        // Apply filters
        if (status) all = all.filter(c => c.status === String(status));
        if (category) all = all.filter(c => c.category === String(category));
        if (priority) all = all.filter(c => c.priority === String(priority));

        // Enrich with complainant names
        const users = await db.select().from(usersTable);
        const students = await db.select().from(studentsTable);
        const staff = await db.select().from(staffTable);
        
        const userMap = Object.fromEntries(users.map(u => [u.id, u]));
        const studentMap = Object.fromEntries(students.map(s => [s.id, s]));
        const staffMap = Object.fromEntries(staff.map(s => [s.id, s]));

        const enriched = all.map(c => {
            let complainantName = "Unknown";
            if (c.complainantType === "user") {
                complainantName = userMap[c.complainantId]?.name || `User ${c.complainantId}`;
            } else if (c.complainantType === "student") {
                complainantName = studentMap[c.complainantId]?.name || `Student ${c.complainantId}`;
            } else if (c.complainantType === "staff") {
                complainantName = staffMap[c.complainantId]?.name || `Staff ${c.complainantId}`;
            }
            return {
                ...c,
                complainantName,
                createdAt: c.createdAt.toISOString(),
                updatedAt: c.updatedAt?.toISOString() || c.createdAt.toISOString(),
            };
        });

        return res.json(enriched);
    } catch (err) {
        req.log.error({ err }, "List complaints error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ─── POST /api/complaints ───
router.post("/complaints", requireRole(...CREATE_ROLES), async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Not authenticated" });
        
        const me = req.user;
        const data = req.body;

        if (!data.title || !data.description) {
            return res.status(400).json({ error: "Title and description are required" });
        }

        if (data.title.length < 5) {
            return res.status(400).json({ error: "Title must be at least 5 characters" });
        }

        if (data.description.length < 20) {
            return res.status(400).json({ error: "Description must be at least 20 characters" });
        }

        // ── SERVER-DETERMINED COMPLAINANT ──
        let complainantType;
        let complainantId;

        if (me.role === "student") {
            const myStudent = await resolveStudentForUser(me);
            if (!myStudent) return res.status(403).json({ error: "Student record not found" });
            complainantType = "student";
            complainantId = myStudent.id;
        } 
        else if (me.role === "parent") {
            // Parent complains on behalf of their child
            const myChildren = await resolveChildrenForParent(me);
            const child = data.applicantId ? myChildren.find(c => c.id === data.applicantId) : myChildren[0];
            if (!child) return res.status(403).json({ error: "No child record found" });
            complainantType = "student";
            complainantId = child.id;
        }
        else if (me.role === "admin") {
            // Admin can complain on behalf of anyone
            complainantType = data.complainantType || "user";
            complainantId = data.complainantId || me.id;
        }
        else {
            // Staff roles complain for themselves
            const staff = await db.select().from(staffTable);
            const myStaff = staff.find(s => s.userId === me.id || s.email === me.email);
            if (myStaff) {
                complainantType = "staff";
                complainantId = myStaff.id;
            } else {
                complainantType = "user";
                complainantId = me.id;
            }
        }

        const [complaint] = await db.insert(complaintsTable).values({
            complainantId,
            complainantType,
            category: data.category || "general",
            title: data.title,
            description: data.description,
            priority: data.priority || "medium",
            status: "pending",
        }).returning();

        // Enrich response with name
        let complainantName = "Unknown";
        if (complainantType === "user") {
            const user = await db.select().from(usersTable).where(eq(usersTable.id, complainantId));
            complainantName = user[0]?.name || `User ${complainantId}`;
        } else if (complainantType === "student") {
            const student = await db.select().from(studentsTable).where(eq(studentsTable.id, complainantId));
            complainantName = student[0]?.name || `Student ${complainantId}`;
        } else if (complainantType === "staff") {
            const staff = await db.select().from(staffTable).where(eq(staffTable.id, complainantId));
            complainantName = staff[0]?.name || `Staff ${complainantId}`;
        }

        return res.status(201).json({
            ...complaint,
            complainantName,
            createdAt: complaint.createdAt.toISOString(),
        });
    } catch (err) {
        req.log.error({ err }, "Create complaint error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ─── PATCH /api/complaints/:id ───
router.patch("/complaints/:id", requireRole(...UPDATE_ROLES), async (req, res) => {
    try {
        const me = req.user;
        const data = req.body;
        const id = parseInt(String(req.params.id));

        const existing = await db.select().from(complaintsTable).where(eq(complaintsTable.id, id));
        const cur = existing[0];
        if (!cur) return res.status(404).json({ error: "Complaint not found" });

        // Check if user has permission to update this complaint
        if (me.role !== "admin") {
            // Non-admin can only update complaints in their department
            const staff = await db.select().from(staffTable);
            const myStaff = staff.find(s => s.userId === me.id || s.email === me.email);
            
            let hasPermission = false;
            
            // Check if user is the complainant
            if (cur.complainantId === me.id && cur.complainantType === "user") {
                hasPermission = true;
            } else if (myStaff && cur.complainantId === myStaff.id && cur.complainantType === "staff") {
                hasPermission = true;
            }

            // Check department permissions
            if (me.role === "teacher" && cur.category === "academic") hasPermission = true;
            if (me.role === "hostel_warden" && cur.category === "hostel") hasPermission = true;
            if (me.role === "transport_manager" && cur.category === "transport") hasPermission = true;
            if (me.role === "store_manager" && cur.category === "inventory") hasPermission = true;
            if (me.role === "librarian" && cur.category === "library") hasPermission = true;
            if (me.role === "accountant" && cur.category === "finance") hasPermission = true;
            if (me.role === "clerk") hasPermission = true; // Clerk can update all general complaints

            if (!hasPermission) {
                return res.status(403).json({ error: "You don't have permission to update this complaint" });
            }

            // Non-admin can only update status and remarks
            if (data.title || data.description || data.category || data.priority) {
                return res.status(400).json({ 
                    error: "Only admin can update title, description, category, or priority" 
                });
            }
        }

        const upd = {};
        if (data.status !== undefined) upd.status = data.status;
        if (data.remarks !== undefined) upd.remarks = data.remarks;
        if (data.title !== undefined && me.role === "admin") upd.title = data.title;
        if (data.description !== undefined && me.role === "admin") upd.description = data.description;
        if (data.category !== undefined && me.role === "admin") upd.category = data.category;
        if (data.priority !== undefined && me.role === "admin") upd.priority = data.priority;

        if (Object.keys(upd).length === 0) {
            return res.status(400).json({ error: "No valid fields to update" });
        }

        const [updated] = await db.update(complaintsTable)
            .set(upd)
            .where(eq(complaintsTable.id, id))
            .returning();

        // Enrich with complainant name
        let complainantName = "Unknown";
        if (updated.complainantType === "user") {
            const user = await db.select().from(usersTable).where(eq(usersTable.id, updated.complainantId));
            complainantName = user[0]?.name || `User ${updated.complainantId}`;
        } else if (updated.complainantType === "student") {
            const student = await db.select().from(studentsTable).where(eq(studentsTable.id, updated.complainantId));
            complainantName = student[0]?.name || `Student ${updated.complainantId}`;
        } else if (updated.complainantType === "staff") {
            const staff = await db.select().from(staffTable).where(eq(staffTable.id, updated.complainantId));
            complainantName = staff[0]?.name || `Staff ${updated.complainantId}`;
        }

        return res.json({
            ...updated,
            complainantName,
            createdAt: updated.createdAt.toISOString(),
            updatedAt: updated.updatedAt?.toISOString() || updated.createdAt.toISOString(),
        });
    } catch (err) {
        req.log.error({ err }, "Update complaint error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ─── GET /api/complaints/stats ───
router.get("/complaints/stats", requireRole("admin"), async (req, res) => {
    try {
        const all = await db.select().from(complaintsTable);
        
        const stats = {
            total: all.length,
            pending: all.filter(c => c.status === "pending").length,
            inProgress: all.filter(c => c.status === "in-progress").length,
            resolved: all.filter(c => c.status === "resolved").length,
            rejected: all.filter(c => c.status === "rejected").length,
            byCategory: {},
            byPriority: {},
        };

        all.forEach(c => {
            stats.byCategory[c.category] = (stats.byCategory[c.category] || 0) + 1;
            stats.byPriority[c.priority] = (stats.byPriority[c.priority] || 0) + 1;
        });

        return res.json(stats);
    } catch (err) {
        req.log.error({ err }, "Complaint stats error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// Suppress unused import warning
void usersTable;
export default router;
