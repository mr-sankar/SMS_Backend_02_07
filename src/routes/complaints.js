import { Router } from "express";
import { db } from "@workspace/db";
import { complaintsTable, usersTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { requireRole } from "../middlewares/auth";
const router = Router();


const READ_ROLES = ["admin", "clerk", "hostel_warden", "teacher", "student", "parent", "accountant", "transport_manager", "librarian", "store_manager", "driver","vendor"];
const COMPLAINT_ROLES = ["clerk", "hostel_warden", "teacher", "student", "parent", "accountant", "transport_manager", "librarian", "store_manager", "driver","vendor"];


const RESOLVE_ROLES = ["admin", "clerk", "hostel_warden"];
const DELETE_ROLES = READ_ROLES;
const SELF_SCOPED_ROLES = ["student", "parent", "teacher", "accountant", "transport_manager", "librarian", "store_manager", "driver"];



router.get("/complaints", requireRole(...READ_ROLES), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const { status, category } = req.query;
        const users = await db.select().from(usersTable);
        const userMap = Object.fromEntries(users.map((u) => [u.id, { name: u.name, role: u.role }]));
        let all = await db
            .select()
            .from(complaintsTable)
            .orderBy(desc(complaintsTable.createdAt), desc(complaintsTable.id));
        // General users only see what they submitted; wardens manage hostel complaints.
        if (SELF_SCOPED_ROLES.includes(me.role)) {
            all = all.filter((c) => c.submittedById === me.id);
        }
        if (me.role === "hostel_warden") {
            all = all.filter((c) => c.category === "hostel" || c.submittedById === me.id);
        }
        if (status)
            all = all.filter((c) => c.status === String(status));
        if (category)
            all = all.filter((c) => c.category === String(category));
        return res.json(all.map((c) => ({
            ...c,
            submittedBy: userMap[c.submittedById]?.name ?? `User ${c.submittedById}`,
            submittedByRole: userMap[c.submittedById]?.role ?? "unknown",
            createdAt: c.createdAt.toISOString(),
            resolvedAt: c.resolvedAt?.toISOString() ?? null,
        })));
    }
    catch (err) {
        req.log.error({ err }, "List complaints error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/complaints", requireRole(...COMPLAINT_ROLES), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const data = req.body;
        const [complaint] = await db.insert(complaintsTable).values({
            title: data.title,
            description: data.description,
            category: data.category,
            submittedById: me.id,
            priority: data.priority ?? "medium",
            status: "open",
        }).returning();
        return res.status(201).json({
            ...complaint,
            submittedBy: me.name,
            submittedByRole: me.role,
            createdAt: complaint.createdAt.toISOString(),
            resolvedAt: null,
        });
    }
    catch (err) {
        req.log.error({ err }, "Create complaint error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.patch("/complaints/:id", requireRole(...RESOLVE_ROLES), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const id = parseInt(String(req.params.id));
        const [existing] = await db.select().from(complaintsTable).where(eq(complaintsTable.id, id));
        if (!existing)
            return res.status(404).json({ error: "Not found" });
        if (req.user.role === "hostel_warden" && existing.category !== "hostel")
            return res.status(403).json({ error: "Hostel wardens can update only hostel complaints" });
        const data = req.body;
        const upd = {};
        if (data.status !== undefined)
            upd.status = data.status;
        if (data.assignedTo !== undefined)
            upd.assignedTo = data.assignedTo;
        if (data.resolution !== undefined) {
            upd.resolution = data.resolution;
            if (data.status === "resolved")
                upd.resolvedAt = new Date();
        }
        const [updated] = await db.update(complaintsTable).set(upd).where(eq(complaintsTable.id, id)).returning();
        if (!updated)
            return res.status(404).json({ error: "Not found" });
        return res.json({
            ...updated,
            submittedBy: "User",
            submittedByRole: "unknown",
            createdAt: updated.createdAt.toISOString(),
            resolvedAt: updated.resolvedAt?.toISOString() ?? null,
        });
    }
    catch (err) {
        req.log.error({ err }, "Update complaint error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.delete("/complaints/:id", requireRole(...DELETE_ROLES), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const id = parseInt(String(req.params.id));
        const [existing] = await db.select().from(complaintsTable).where(eq(complaintsTable.id, id));
        if (!existing)
            return res.status(404).json({ error: "Not found" });
        const canDelete = req.user.role === "admin" ||
            req.user.role === "clerk" ||
            existing.submittedById === req.user.id ||
            (req.user.role === "hostel_warden" && existing.category === "hostel");
        if (!canDelete)
            return res.status(403).json({ error: "You can delete only complaints you raised" });
        const [deleted] = await db.delete(complaintsTable).where(eq(complaintsTable.id, id)).returning();
        if (!deleted)
            return res.status(404).json({ error: "Not found" });
        return res.json({ success: true });
    }
    catch (err) {
        req.log.error({ err }, "Delete complaint error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
export default router;
