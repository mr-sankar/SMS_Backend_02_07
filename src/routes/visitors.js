import { Router } from "express";
import { db } from "@workspace/db";
import { visitorLogTable, phoneCallLogsTable, postalCourierLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireRole } from "../middlewares/auth";
const router = Router();
const visitorAdminRoles = ["admin", "clerk", "hostel_warden"];
function normalizeImageUrl(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}
router.get("/visitors", requireRole(...visitorAdminRoles), async (req, res) => {
    try {
        const { status } = req.query;
        let all = await db.select().from(visitorLogTable);
        if (status)
            all = all.filter((v) => v.status === String(status));
        return res.json(all.map((v) => ({
            ...v,
            checkIn: v.checkIn.toISOString(),
            checkOut: v.checkOut?.toISOString() ?? null,
        })));
    }
    catch (err) {
        req.log.error({ err }, "List visitors error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/visitors", requireRole(...visitorAdminRoles), async (req, res) => {
    try {
        const data = req.body;
        const badge = `B-${String(Date.now()).slice(-4)}`;
        const [visitor] = await db.insert(visitorLogTable).values({
            visitorName: data.visitorName,
            visitorPhone: data.visitorPhone ?? null,
            purpose: data.purpose,
            personToMeet: data.personToMeet,
            department: data.department ?? null,
            idType: data.idType ?? null,
            idNumber: data.idNumber ?? null,
            badge,
            status: "inside",
            remarks: data.remarks ?? null,
        }).returning();
        return res.status(201).json({
            ...visitor,
            checkIn: visitor.checkIn.toISOString(),
            checkOut: null,
        });
    }
    catch (err) {
        req.log.error({ err }, "Log visitor error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.patch("/visitors/:id", requireRole(...visitorAdminRoles), async (req, res) => {
    try {
        const data = req.body;
        const upd = {};
        if (data.status !== undefined)
            upd.status = data.status;
        if (data.remarks !== undefined)
            upd.remarks = data.remarks;
        if (data.status === "departed")
            upd.checkOut = new Date();
        const [updated] = await db.update(visitorLogTable).set(upd).where(eq(visitorLogTable.id, parseInt(String(req.params.id)))).returning();
        if (!updated)
            return res.status(404).json({ error: "Not found" });
        return res.json({
            ...updated,
            checkIn: updated.checkIn.toISOString(),
            checkOut: updated.checkOut?.toISOString() ?? null,
        });
    }
    catch (err) {
        req.log.error({ err }, "Update visitor error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ─── PHONE CALL LOGS ────────────────────────────────────────────────────────
router.get("/visitors/calls", requireRole(...visitorAdminRoles), async (req, res) => {
    try {
        const all = await db.select().from(phoneCallLogsTable);
        return res.json(all);
    }
    catch (err) {
        req.log.error({ err }, "List phone call logs error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/visitors/calls", requireRole(...visitorAdminRoles), async (req, res) => {
    try {
        const data = req.body;
        if (!data.contactName || !data.phoneNumber || !data.callType) {
            return res.status(400).json({ error: "Missing required fields" });
        }
        const [callLog] = await db.insert(phoneCallLogsTable).values({
            contactName: data.contactName,
            phoneNumber: data.phoneNumber,
            callType: data.callType,
            purpose: data.purpose ?? null,
            followUpDate: data.followUpDate ?? null,
            remarks: data.remarks ?? null,
        }).returning();
        return res.status(201).json(callLog);
    }
    catch (err) {
        req.log.error({ err }, "Create phone call log error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ─── POSTAL & COURIER LOGS ──────────────────────────────────────────────────
router.get("/visitors/postal", requireRole(...visitorAdminRoles), async (req, res) => {
    try {
        const all = await db.select().from(postalCourierLogsTable);
        return res.json(all);
    }
    catch (err) {
        req.log.error({ err }, "List postal courier logs error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/visitors/postal", requireRole(...visitorAdminRoles), async (req, res) => {
    try {
        const data = req.body;
        if (!data.type || !data.senderName || !data.receiverName) {
            return res.status(400).json({ error: "Missing required fields" });
        }
        const [postalLog] = await db.insert(postalCourierLogsTable).values({
            type: data.type,
            referenceNumber: data.referenceNumber ?? null,
            senderName: data.senderName,
            receiverName: data.receiverName,
            courierService: data.courierService ?? null,
            imageUrl: normalizeImageUrl(data.imageUrl),
            dispatchStatus: data.dispatchStatus || "pending",
            date: data.date ?? null,
            remarks: data.remarks ?? null,
        }).returning();
        return res.status(201).json(postalLog);
    }
    catch (err) {
        req.log.error({ err }, "Create postal courier log error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.patch("/visitors/postal/:id", requireRole(...visitorAdminRoles), async (req, res) => {
    try {
        const data = req.body;
        const upd = {};
        if (data.dispatchStatus !== undefined)
            upd.dispatchStatus = data.dispatchStatus;
        if (data.remarks !== undefined)
            upd.remarks = data.remarks;
        if (data.imageUrl !== undefined)
            upd.imageUrl = normalizeImageUrl(data.imageUrl);
        const [updated] = await db.update(postalCourierLogsTable).set(upd).where(eq(postalCourierLogsTable.id, parseInt(String(req.params.id)))).returning();
        if (!updated)
            return res.status(404).json({ error: "Not found" });
        return res.json(updated);
    }
    catch (err) {
        req.log.error({ err }, "Update postal courier log error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

export default router;
