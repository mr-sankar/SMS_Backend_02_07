import { Router } from "express";
import { db } from "@workspace/db";
import { vendorsTable, purchaseOrdersTable, announcementsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireRole } from "../middlewares/auth";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { Readable } from "stream";
import { sendStaffCredentialsEmail } from "../lib/email";
import multer from "multer";
const router = Router();
const objectStorage = new ObjectStorageService();
const INVOICE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
// ============================================
// HELPER FUNCTIONS - Add these at the top
// ============================================

// Generate random password (EXACTLY like staff)
function generatePassword() {
    const charset = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    let pwd = "";
    for (let i = 0; i < 8; i++) {
        pwd += charset[Math.floor(Math.random() * charset.length)];
    }
    return `${pwd}!`;
}

// Hash password
async function hashPassword(password) {
    const bcrypt = await import('bcrypt');
    return bcrypt.hash(password, 10);
}

// Slugify name for username (EXACTLY like staff)
function slugifyName(name) {
    if (!name) return "vendor";
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "_")
        .replace(/_+/g, "_")
        .slice(0, 20);
}

// Generate vendor ID prefix
function vendorPrefix() {
    const year = new Date().getFullYear();
    return `VND${year}`;
}

// Serialize vendor data
function serializeVendor(vendor) {
    return {
        ...vendor,
        rating: vendor.rating ? Number(vendor.rating) : null,
        registeredAt: vendor.registeredAt ? vendor.registeredAt.toISOString() : null,
        renewalDate: vendor.renewalDate || null,
    };
}

function serializePurchaseOrder(po, vendorName) {
    return {
        ...po,
        totalAmount: Number(po.totalAmount),
        vendorName: vendorName ?? `Vendor ${po.vendorId}`,
        items: po.items ?? [],
        sourceRole: po.sourceRole ?? "admin",
        createdBy: po.createdBy ?? null,
        adminAcceptedAt: po.adminAcceptedAt ? po.adminAcceptedAt.toISOString() : null,
        adminAcceptedBy: po.adminAcceptedBy ?? null,
        vendorConfirmedAt: po.vendorConfirmedAt ? po.vendorConfirmedAt.toISOString() : null,
        vendorConfirmedBy: po.vendorConfirmedBy ?? null,
        invoiceUrl: po.invoiceUrl ?? null,
        invoiceNumber: po.invoiceNumber ?? null,
        paidAt: po.paidAt ? po.paidAt.toISOString() : null,
        paymentReference: po.paymentReference ?? null,
        amountPaid: po.amountPaid != null ? Number(po.amountPaid) : null,
        createdAt: po.createdAt.toISOString(),
    };
}
const invoiceUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: INVOICE_MAX_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
        if (file.mimetype !== "application/pdf") {
            cb(new Error("INVOICE_NOT_PDF"));
            return;
        }
        cb(null, true);
    },
});
// Middleware wrapper that translates multer's errors (size, count, mime)
// into clean 4xx JSON responses instead of bubbling them into the generic
// error handler.
function invoiceUploadMw(req, res, next) {
    invoiceUpload.single("file")(req, res, (err) => {
        if (!err) {
            next();
            return;
        }
        const e = err;
        if (e?.name === "MulterError" || typeof e?.code === "string" && e.code.startsWith("LIMIT_")) {
            if (e.code === "LIMIT_FILE_SIZE") {
                res.status(413).json({ error: `Invoice exceeds maximum size of ${INVOICE_MAX_BYTES / (1024 * 1024)} MB` });
                return;
            }
            if (e.code === "LIMIT_FILE_COUNT" || e.code === "LIMIT_UNEXPECTED_FILE") {
                res.status(400).json({ error: "Exactly one file is allowed (multipart field 'file')" });
                return;
            }
            res.status(400).json({ error: `Upload error: ${e.code ?? "unknown"}` });
            return;
        }
        if (e?.message === "INVOICE_NOT_PDF") {
            res.status(415).json({ error: "Invoice must be a PDF (application/pdf)" });
            return;
        }
        next(err);
    });
}
// Approve / reject a vendor (admin only)
const approveVendor = async (req, res, status) => {
    try {
        const id = parseInt(String(req.params.id));
        const [updated] = await db.update(vendorsTable).set({ status }).where(eq(vendorsTable.id, id)).returning();
        if (!updated)
            return res.status(404).json({ error: "Not found" });
        return res.json({ ...updated, rating: updated.rating ? Number(updated.rating) : null, registeredAt: updated.registeredAt.toISOString() });
    }
    catch (err) {
        req.log.error({ err }, "Approve vendor error");
        return res.status(500).json({ error: "Internal server error" });
    }
};
const MANAGER_ROLES = ["admin", "store_manager", "accountant"];
router.get("/vendors", requireRole("admin", "store_manager", "accountant", "clerk", "vendor"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        let all = await db.select().from(vendorsTable);
        if (me.role === "vendor") {
            all = all.filter((v) => v.email === me.email);
        }
        else if (!MANAGER_ROLES.includes(me.role)) {
            return res.status(403).json({ error: "Forbidden" });
        }
        return res.json(all.map((v) => ({ ...v, rating: v.rating ? Number(v.rating) : null, registeredAt: v.registeredAt.toISOString() })));
    }
    catch (err) {
        req.log.error({ err }, "List vendors error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// CREATE VENDOR - EXACTLY LIKE STAFF PATTERN
router.post("/vendors", requireRole("admin", "store_manager", "accountant"), async (req, res) => {
    try {
        const data = req.body ?? {};
        
        // Validate required fields (similar to staff)
        if (!data.name || !data.category || !data.email) {
            return res.status(400).json({ 
                error: "Missing required fields: name, category, email" 
            });
        }

        const prefix = vendorPrefix();
        const base = slugifyName(data.name);
        const password = generatePassword();
        const passwordHash = await hashPassword(password);

        let lastErr;
        // Retry on unique violation (EXACTLY like staff pattern)
        for (let attempt = 0; attempt < 6; attempt++) {
            // Recompute the next sequence for this prefix
            const taken = (await db.select({ vendorId: vendorsTable.vendorId }).from(vendorsTable))
                .map((r) => r.vendorId)
                .filter((v) => !!v && v.startsWith(prefix))
                .map((v) => parseInt(v.slice(prefix.length), 10))
                .filter((n) => !Number.isNaN(n));
            
            const seq = (taken.length ? Math.max(...taken) : 0) + 1 + attempt;
            const vendorId = `${prefix}${String(seq).padStart(3, "0")}`;
            const suffix = vendorId.slice(-3);
            
            // Generate unique username (EXACTLY like staff)
            let username = `${base}${suffix}`;
            let suffixN = 0;
            while ((await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.username, username))).length > 0) {
                suffixN += 1;
                username = `${base}${suffix}${suffixN}`;
                if (suffixN > 50) {
                    return res.status(500).json({ error: "Could not allocate unique username" });
                }
            }

            try {
                // Transaction - EXACTLY like staff pattern
                const { vendor, userId } = await db.transaction(async (tx) => {
                    // 1. Insert vendor record
                    const [v] = await tx.insert(vendorsTable).values({
                        vendorId,
                        name: data.name,
                        category: data.category,
                        contactPerson: data.contactPerson ?? null,
                        email: data.email,
                        phone: data.phone ?? null,
                        address: data.address ?? null,
                        gstNumber: data.gstNumber ?? null,
                        bankAccount: data.bankAccount ?? null,
                        renewalDate: data.renewalDate ?? null,
                        renewalStatus: data.renewalStatus ?? "active",
                        status: data.status ?? "pending_verification",
                        documents: data.documents ?? [],
                        userId: null,
                    }).returning();

                    // 2. Insert user record (EXACTLY like staff)
                    const [u] = await tx.insert(usersTable).values({
                        username,
                        password: passwordHash,
                        role: "vendor",
                        name: data.name,
                        email: data.email,
                        phone: data.phone ?? null,
                    }).returning();

                    // 3. Update vendor with userId (EXACTLY like staff)
                    const [linked] = await tx
                        .update(vendorsTable)
                        .set({ userId: u.id })
                        .where(eq(vendorsTable.id, v.id))
                        .returning();

                    return { vendor: linked ?? { ...v, userId: u.id }, userId: u.id };
                });

                // Send credentials email in the background without blocking the response
                sendStaffCredentialsEmail({
                    to: data.email,
                    name: data.name,
                    staffId: vendorId,
                    username,
                    password,
                }).then(() => {
                    req.log.info(`Vendor credentials email sent to ${data.email}`);
                }).catch((emailErr) => {
                    req.log.error(
                        { emailErr },
                        `Failed to send vendor credentials email to ${data.email}`
                    );
                });

                // Return response with credentials (EXACTLY like staff)
                return res.status(201).json({
                    ...serializeVendor(vendor),
                    userId,
                    // Plaintext password is returned ONCE; only the bcrypt hash is persisted
                    credentials: { 
                        vendorId, 
                        username, 
                        password 
                    },
                });

            } catch (err) {
                const code = err?.code;
                // 23505 = postgres unique_violation; retry with bumped sequence
                if (code === "23505") {
                    lastErr = err;
                    continue;
                }
                throw err;
            }
        }

        req.log.error({ err: lastErr }, "Vendor create exhausted retries on unique-violation");
        return res.status(409).json({ error: "Could not allocate a unique vendor ID. Try again." });

    } catch (err) {
        req.log.error({ err }, "Create vendor error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

// GET VENDOR BY ID - UPDATED to include user details
router.get("/vendors/:id", requireRole("admin", "store_manager", "accountant", "clerk", "vendor"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const all = await db.select().from(vendorsTable).where(eq(vendorsTable.id, parseInt(String(req.params.id))));
        if (!all[0])
            return res.status(404).json({ error: "Not found" });
        const v = all[0];
        if (me.role === "vendor" && v.email !== me.email)
            return res.status(403).json({ error: "Forbidden" });
        if (!MANAGER_ROLES.includes(me.role) && me.role !== "vendor")
            return res.status(403).json({ error: "Forbidden" });
        
        // Get user details if exists
        let userDetails = null;
        if (v.userId) {
            const [user] = await db
                .select()
                .from(usersTable)
                .where(eq(usersTable.id, v.userId));
            if (user) {
                // Remove password from response
                const { password, ...userWithoutPassword } = user;
                userDetails = userWithoutPassword;
            }
        }
        
        return res.json({
            ...serializeVendor(v),
            user: userDetails
        });
    } catch (err) {
        req.log.error({ err }, "Get vendor error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/vendors/:id/approve", requireRole("admin"), (req, res) => approveVendor(req, res, "active"));
router.post("/vendors/:id/reject", requireRole("admin"), (req, res) => approveVendor(req, res, "rejected"));
router.post("/vendors/:id/suspend", requireRole("admin"), (req, res) => approveVendor(req, res, "suspended"));
router.patch("/vendors/:id", requireRole("admin", "store_manager", "accountant", "vendor"), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        if (req.user?.role === "vendor") {
            const [myVendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, id));
            if (!myVendor || (myVendor.userId !== req.user.id && myVendor.email !== req.user.email)) {
                return res.status(403).json({ error: "Forbidden", details: "Vendors can only update their own profile" });
            }
        }
        const data = req.body;
        const upd = {};
        if (data.contactPerson !== undefined)
            upd.contactPerson = data.contactPerson;
        if (data.phone !== undefined)
            upd.phone = data.phone;
        if (data.address !== undefined)
            upd.address = data.address;
        if (data.bankAccount !== undefined)
            upd.bankAccount = data.bankAccount;
        if (data.documents !== undefined)
            upd.documents = data.documents;

        const isManager = ["admin", "store_manager", "accountant"].includes(req.user?.role);
        if (isManager) {
            if (data.status !== undefined)
                upd.status = data.status;
            if (data.contracts !== undefined)
                upd.contracts = data.contracts;
            if (data.renewalStatus !== undefined)
                upd.renewalStatus = data.renewalStatus;
            if (data.renewalDate !== undefined)
                upd.renewalDate = data.renewalDate;
            if (data.communicationLog !== undefined)
                upd.communicationLog = data.communicationLog;
        }

        const [updated] = await db.update(vendorsTable).set(upd).where(eq(vendorsTable.id, id)).returning();
        if (!updated)
            return res.status(404).json({ error: "Not found" });
        return res.json({ ...updated, rating: updated.rating ? Number(updated.rating) : null, registeredAt: updated.registeredAt.toISOString() });
    }
    catch (err) {
        req.log.error({ err }, "Update vendor error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.get("/purchase-orders", requireRole("admin", "store_manager", "accountant", "vendor"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const { vendorId, status } = req.query;
        const vendors = await db.select().from(vendorsTable);
        const vendorMap = Object.fromEntries(vendors.map((v) => [v.id, v.name]));
        let all = await db.select().from(purchaseOrdersTable);
        if (me.role === "vendor") {
            const myVendor = vendors.find((v) => v.email === me.email);
            all = myVendor ? all.filter((p) => p.vendorId === myVendor.id) : [];
            all = all.filter((p) => (p.sourceRole ?? "admin") !== "store_manager" || !!p.adminAcceptedAt);
        }
        else if (!MANAGER_ROLES.includes(me.role)) {
            return res.status(403).json({ error: "Forbidden" });
        }
        if (vendorId)
            all = all.filter((p) => p.vendorId === parseInt(String(vendorId)));
        if (status)
            all = all.filter((p) => p.status === String(status));
        return res.json(all.map((p) => serializePurchaseOrder(p, vendorMap[p.vendorId])));
    }
    catch (err) {
        req.log.error({ err }, "List purchase orders error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/purchase-orders", requireRole("admin", "store_manager", "accountant"), async (req, res) => {
    try {
        const data = req.body;
        const [selectedVendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, Number(data.vendorId)));
        if (!selectedVendor)
            return res.status(404).json({ error: "Vendor not found" });
        if (selectedVendor.status !== "active" && selectedVendor.status !== "approved")
            return res.status(400).json({ error: "Purchase orders can only be assigned to approved active vendors" });
        const items = data.items.map((item) => ({
            ...item,
            total: item.quantity * item.unitPrice,
        }));
        const totalAmount = items.reduce((sum, i) => sum + i.total, 0);
        const poNumber = `PO-${Date.now()}`;
        const sourceRole = req.user?.role ?? "admin";
        const needsAdminApproval = sourceRole === "store_manager";
        const now = new Date();
        const [po] = await db.insert(purchaseOrdersTable).values({
            poNumber,
            vendorId: data.vendorId,
            items,
            totalAmount: String(totalAmount),
            status: needsAdminApproval ? "pending_admin_approval" : "sent",
            sourceRole,
            createdBy: req.user?.id ?? null,
            adminAcceptedAt: needsAdminApproval ? null : now,
            adminAcceptedBy: needsAdminApproval ? null : req.user?.id ?? null,
            deliveryDate: data.deliveryDate ?? null,
            notes: data.notes ?? null,
        }).returning();
        return res.status(201).json(serializePurchaseOrder({ ...po, items }, selectedVendor.name));
    }
    catch (err) {
        req.log.error({ err }, "Create purchase order error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.get("/purchase-orders/:id", requireRole("admin", "store_manager", "accountant", "vendor"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const all = await db.select().from(purchaseOrdersTable).where(eq(purchaseOrdersTable.id, parseInt(String(req.params.id))));
        if (!all[0])
            return res.status(404).json({ error: "Not found" });
        const po = all[0];
        if (me.role === "vendor") {
            const vs = await db.select().from(vendorsTable).where(eq(vendorsTable.id, po.vendorId));
            if (vs[0]?.email !== me.email)
                return res.status(403).json({ error: "Forbidden" });
            if ((po.sourceRole ?? "admin") === "store_manager" && !po.adminAcceptedAt)
                return res.status(404).json({ error: "Not found" });
        }
        else if (!MANAGER_ROLES.includes(me.role)) {
            return res.status(403).json({ error: "Forbidden" });
        }
        const vendors = await db.select().from(vendorsTable).where(eq(vendorsTable.id, po.vendorId));
        return res.json(serializePurchaseOrder(po, vendors[0]?.name));
    }
    catch (err) {
        req.log.error({ err }, "Get purchase order error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// Vendors may only advance their PO through this forward chain.
// `acknowledged -> invoiced` is intentionally excluded: vendors must move
// to "invoiced" via POST /purchase-orders/:id/invoice (which requires a
// PDF attachment), never via the generic PATCH endpoint.
const VENDOR_NEXT_STATUS = {
    sent: "acknowledged",
    invoiced: "delivered",
};
router.patch("/purchase-orders/:id", requireRole("admin", "store_manager", "accountant", "vendor"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const existing = await db.select().from(purchaseOrdersTable).where(eq(purchaseOrdersTable.id, parseInt(String(req.params.id))));
        if (!existing[0])
            return res.status(404).json({ error: "Not found" });
        if (me.role === "vendor") {
            const vs = await db.select().from(vendorsTable).where(eq(vendorsTable.id, existing[0].vendorId));
            if (vs[0]?.email !== me.email)
                return res.status(403).json({ error: "Forbidden" });
        }
        else if (!MANAGER_ROLES.includes(me.role)) {
            return res.status(403).json({ error: "Forbidden" });
        }
        const data = req.body;
        const upd = {};
        if (me.role === "vendor") {
            // Vendor may only change status, and only to the allowed next step
            if (data.status === undefined)
                return res.status(400).json({ error: "Vendor may only update status" });
            if (data.status === "invoiced") {
                return res.status(400).json({ error: "Use POST /api/purchase-orders/:id/invoice to mark as invoiced (PDF required)" });
            }
            const allowed = VENDOR_NEXT_STATUS[existing[0].status];
            if (allowed !== data.status) {
                return res.status(400).json({ error: `Cannot move from ${existing[0].status} to ${data.status}` });
            }
            upd.status = data.status;
            if (data.status === "acknowledged") {
                upd.vendorConfirmedAt = new Date();
                upd.vendorConfirmedBy = me.id;
            }
        }
        else {
            if (data.adminAccepted === true) {
                if (me.role !== "admin") {
                    return res.status(403).json({ error: "Only admin can accept store manager purchase orders" });
                }
                if ((existing[0].sourceRole ?? "admin") !== "store_manager") {
                    return res.status(400).json({ error: "Only store manager purchase orders require admin acceptance" });
                }
                if (existing[0].adminAcceptedAt) {
                    return res.status(400).json({ error: "Purchase order is already accepted" });
                }
                upd.adminAcceptedAt = new Date();
                upd.adminAcceptedBy = me.id;
                upd.status = "sent";
            }
            if (data.status === "paid") {
                return res.status(400).json({ error: "Use POST /api/purchase-orders/:id/pay to record a payment" });
            }
            if (data.status === "acknowledged") {
                return res.status(400).json({ error: "Vendor must confirm the purchase order" });
            }
            if (data.status !== undefined && data.adminAccepted !== true)
                upd.status = data.status;
            if (data.deliveryDate !== undefined)
                upd.deliveryDate = data.deliveryDate;
            if (data.notes !== undefined)
                upd.notes = data.notes;
        }
        const [updated] = await db.update(purchaseOrdersTable).set(upd).where(eq(purchaseOrdersTable.id, parseInt(String(req.params.id)))).returning();
        if (!updated)
            return res.status(404).json({ error: "Not found" });
        const vendors = await db.select().from(vendorsTable).where(eq(vendorsTable.id, updated.vendorId));
        return res.json(serializePurchaseOrder(updated, vendors[0]?.name));
    }
    catch (err) {
        req.log.error({ err }, "Update purchase order error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// Vendor uploads an invoice PDF for one of their POs as multipart/form-data.
// The server ingests the file directly (single hop) and writes it to GCS,
// then links the resulting object path to the PO. Because the server picks
// the object path, vendors cannot reference or attach objects owned by
// anyone else.
// Accountant/admin records a payment against a vendor invoice. Captures
// the payment date, reference (cheque #, UTR, transaction id, etc.), and
// the amount actually paid (may differ from PO total for partial settle-
// ments). Moves status to "paid" exclusively through this endpoint —
// the generic PATCH refuses status=paid so payment metadata is always
// captured.
router.post("/purchase-orders/:id/pay", requireRole("admin", "accountant"), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        if (!Number.isFinite(id))
            return res.status(400).json({ error: "Invalid id" });
        const existing = await db.select().from(purchaseOrdersTable).where(eq(purchaseOrdersTable.id, id));
        if (!existing[0])
            return res.status(404).json({ error: "Not found" });
        const po = existing[0];
        if (po.status === "paid")
            return res.status(400).json({ error: "Already paid" });
        if (!["invoiced", "delivered", "received"].includes(po.status)) {
            return res.status(400).json({ error: `Cannot record payment while PO is ${po.status}` });
        }
        if (!po.invoiceUrl) {
            return res.status(400).json({ error: "Vendor must upload an invoice PDF before payment can be recorded" });
        }
        const body = req.body ?? {};
        const refRaw = typeof body.paymentReference === "string" ? body.paymentReference.trim() : "";
        if (!refRaw)
            return res.status(400).json({ error: "paymentReference is required (cheque #, UTR, etc.)" });
        if (refRaw.length > 100)
            return res.status(400).json({ error: "paymentReference too long (max 100 chars)" });
        const amountNum = typeof body.amountPaid === "number" ? body.amountPaid : Number(body.amountPaid);
        if (!Number.isFinite(amountNum) || amountNum <= 0) {
            return res.status(400).json({ error: "amountPaid must be a positive number" });
        }
        const poTotal = Number(po.totalAmount);
        if (amountNum > poTotal * 1.0001) {
            return res.status(400).json({ error: `amountPaid (₹${amountNum}) exceeds PO total (₹${poTotal})` });
        }
        let paidAt;
        if (body.paidAt) {
            const d = new Date(String(body.paidAt));
            if (Number.isNaN(d.getTime()))
                return res.status(400).json({ error: "Invalid paidAt date" });
            paidAt = d;
        }
        else {
            paidAt = new Date();
        }
        const [updated] = await db
            .update(purchaseOrdersTable)
            .set({
            status: "paid",
            paidAt,
            paymentReference: refRaw,
            amountPaid: amountNum.toFixed(2),
        })
            .where(eq(purchaseOrdersTable.id, id))
            .returning();
        const vendors = await db.select().from(vendorsTable).where(eq(vendorsTable.id, updated.vendorId));
        req.log.info({ poId: id, amountPaid: amountNum, reference: refRaw, by: req.user?.id }, "Vendor invoice marked paid");
        return res.json(serializePurchaseOrder(updated, vendors[0]?.name));
    }
    catch (err) {
        req.log.error({ err }, "Pay purchase order error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/purchase-orders/:id/invoice", requireRole("admin", "store_manager", "accountant", "vendor"), invoiceUploadMw, async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const id = parseInt(String(req.params.id));
        const existing = await db.select().from(purchaseOrdersTable).where(eq(purchaseOrdersTable.id, id));
        if (!existing[0])
            return res.status(404).json({ error: "Not found" });
        const po = existing[0];
        if (me.role !== "vendor") {
            return res.status(403).json({ error: "Only vendors can upload invoices" });
        }
        const vs = await db.select().from(vendorsTable).where(eq(vendorsTable.id, po.vendorId));
        const myVendor = vs[0];
        if (myVendor?.email !== me.email)
            return res.status(403).json({ error: "Forbidden" });
        if (!["acknowledged", "invoiced"].includes(po.status)) {
            return res.status(400).json({ error: `Cannot upload invoice while PO is ${po.status}` });
        }
        const file = req.file;
        if (!file)
            return res.status(400).json({ error: "Invoice PDF file is required (multipart field 'file')" });
        if (file.mimetype !== "application/pdf") {
            return res.status(415).json({ error: "Invoice must be a PDF" });
        }
        // Magic-byte verification: client-set MIME is untrusted. A real PDF
        // starts with "%PDF-" within the first 1024 bytes (per ISO 32000).
        const header = file.buffer.subarray(0, 1024).toString("latin1");
        if (!header.includes("%PDF-")) {
            return res.status(415).json({ error: "File does not appear to be a valid PDF" });
        }
        if (file.size > INVOICE_MAX_BYTES) {
            // Belt-and-suspenders; multer's limit should already prevent this.
            return res.status(413).json({ error: `Invoice exceeds maximum size of ${INVOICE_MAX_BYTES / (1024 * 1024)} MB` });
        }
        const invoiceNumberRaw = typeof req.body?.invoiceNumber === "string" ? req.body.invoiceNumber.trim() : "";
        const invoiceNumber = invoiceNumberRaw.length > 0 ? invoiceNumberRaw.slice(0, 100) : null;
        const objectPath = await objectStorage.uploadObjectEntity(file.buffer, file.mimetype, {
            vendorId: String(myVendor.id),
            poId: String(po.id),
            uploadedBy: String(me.id),
        });
        const [updated] = await db
            .update(purchaseOrdersTable)
            .set({ invoiceUrl: objectPath, invoiceNumber, status: "invoiced" })
            .where(eq(purchaseOrdersTable.id, id))
            .returning();
        const vendors = await db.select().from(vendorsTable).where(eq(vendorsTable.id, updated.vendorId));
        // Notify the accounts team (and store/admin) via an in-app announcement
        // that deep-links into the store purchase orders page with this PO open.
        try {
            const deepLink = `/inventory/orders?po=${updated.id}`;
            const invoiceLabel = invoiceNumber ? ` (Invoice #${invoiceNumber})` : "";
            const vendorName = vendors[0]?.name ?? myVendor.name;
            const title = `New vendor invoice: ${updated.poNumber}`;
            const content = `${vendorName} uploaded an invoice${invoiceLabel} for purchase order ${updated.poNumber} ` +
                `(total ₹${Number(updated.totalAmount).toLocaleString("en-IN")}). ` +
                `Open the PO to review and process payment: ${deepLink}`;
            await db.insert(announcementsTable).values([
                { title, content, audience: "accounts", priority: "important", authorId: me.id },
                { title, content, audience: "store", priority: "normal", authorId: me.id },
            ]);
        }
        catch (notifyErr) {
            req.log.error({ err: notifyErr, poId: updated.id }, "Failed to create invoice announcement");
        }
        return res.json(serializePurchaseOrder(updated, vendors[0]?.name));
    }
    catch (err) {
        req.log.error({ err }, "Upload invoice error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// Download / view the invoice PDF for a PO. Vendor-owner plus management roles.
router.get("/purchase-orders/:id/invoice", requireRole("admin", "store_manager", "accountant", "vendor"), async (req, res) => {
    try {
        if (!req.user) {
            res.status(401).json({ error: "Not authenticated" });
            return;
        }
        const me = req.user;
        const id = parseInt(String(req.params.id));
        const existing = await db.select().from(purchaseOrdersTable).where(eq(purchaseOrdersTable.id, id));
        if (!existing[0]) {
            res.status(404).json({ error: "Not found" });
            return;
        }
        const po = existing[0];
        if (me.role === "vendor") {
            const vs = await db.select().from(vendorsTable).where(eq(vendorsTable.id, po.vendorId));
            if (vs[0]?.email !== me.email) {
                res.status(403).json({ error: "Forbidden" });
                return;
            }
        }
        else if (!MANAGER_ROLES.includes(me.role)) {
            res.status(403).json({ error: "Forbidden" });
            return;
        }
        if (!po.invoiceUrl) {
            res.status(404).json({ error: "No invoice uploaded" });
            return;
        }
        try {
            const file = await objectStorage.getObjectEntityFile(po.invoiceUrl);
            const response = await objectStorage.downloadObject(file, 0);
            res.status(response.status);
            response.headers.forEach((value, key) => res.setHeader(key, value));
            res.setHeader("Content-Disposition", `inline; filename="invoice-${po.poNumber}.pdf"`);
            if (response.body) {
                const nodeStream = Readable.fromWeb(response.body);
                nodeStream.pipe(res);
            }
            else {
                res.end();
            }
        }
        catch (err) {
            if (err instanceof ObjectNotFoundError) {
                res.status(404).json({ error: "Invoice file not found" });
                return;
            }
            throw err;
        }
    }
    catch (err) {
        req.log.error({ err }, "Download invoice error");
        res.status(500).json({ error: "Internal server error" });
    }
});

// p
// Add this route for simple status updates (especially useful for post-creation)
router.patch("/purchase-orders/:id/status", requireRole("admin", "store_manager", "accountant"), async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Not authenticated" });

        const { id } = req.params;
        const { status } = req.body;

        if (!status) return res.status(400).json({ error: "Status is required" });

        const existing = await db.select().from(purchaseOrdersTable).where(eq(purchaseOrdersTable.id, parseInt(id)));
        if (!existing[0]) return res.status(404).json({ error: "Purchase order not found" });

        // Validate allowed status transitions
        const allowedStatuses = ["pending", "pending_admin_approval", "sent", "acknowledged", "invoiced", "delivered", "received", "paid", "cancelled"];
        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({ error: "Invalid status" });
        }
        if (status === "acknowledged") {
            return res.status(400).json({ error: "Vendor must confirm the purchase order" });
        }

        // Prevent invalid transitions (you can expand this logic)
        const currentStatus = existing[0].status;
        const validTransitions = {
            draft: ["pending", "sent"],
            pending_admin_approval: ["sent", "cancelled"],
            pending: ["sent", "cancelled"],
            sent: ["cancelled"],
            acknowledged: ["invoiced", "cancelled"],
            invoiced: ["delivered", "received", "cancelled"],
            delivered: ["received"],
            received: ["paid"],
        };

        if (!validTransitions[currentStatus]?.includes(status)) {
            return res.status(400).json({ 
                error: `Cannot change status from ${currentStatus} to ${status}` 
            });
        }

        const [updated] = await db.update(purchaseOrdersTable)
            .set({ status })
            .where(eq(purchaseOrdersTable.id, parseInt(id)))
            .returning();

        const vendors = await db.select().from(vendorsTable).where(eq(vendorsTable.id, updated.vendorId));

        return res.json(serializePurchaseOrder(updated, vendors[0]?.name));
    } catch (err) {
        req.log.error({ err }, "Update PO status error");
        return res.status(500).json({ error: "Internal server error" });
    }
});


// p

// ====================== DELETE VENDOR ======================
// DELETE /api/vendors/:id
// ====================== DELETE VENDOR ======================
// DELETE /api/vendors/:id
router.delete('/vendors/:id', requireRole('admin'), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        if (isNaN(id)) {
            return res.status(400).json({ error: "Invalid vendor ID" });
        }

        // Check if vendor exists
        const [existing] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, id));
        if (!existing) {
            return res.status(404).json({ error: "Vendor not found" });
        }

        // Optional: Prevent deletion of vendors with active purchase orders
        const activeOrders = await db
            .select({ id: purchaseOrdersTable.id })
            .from(purchaseOrdersTable)
            .where(eq(purchaseOrdersTable.vendorId, id));

        if (activeOrders.length > 0) {
            return res.status(400).json({ 
                error: "Cannot delete vendor with existing purchase orders",
                orderCount: activeOrders.length 
            });
        }

        await db.transaction(async (tx) => {
            // 1. Delete linked user record (if exists)
            if (existing.userId) {
                await tx
                    .delete(usersTable)
                    .where(eq(usersTable.id, existing.userId));
            }

            // 2. Hard delete the vendor
            await tx
                .delete(vendorsTable)
                .where(eq(vendorsTable.id, id));
        });

        res.json({ 
            success: true, 
            message: "Vendor and associated user account deleted permanently from database"
        });

    } catch (error) {
        req.log.error({ err: error }, "Delete vendor error");
        console.error("❌ Delete Vendor Error:", error);
        res.status(500).json({ 
            error: "Failed to delete vendor",
            message: error.message 
        });
    }
});
// ====================== DELETE PURCHASE ORDER ======================
// DELETE /api/purchase-orders/:id
router.delete('/purchase-orders/:id', requireRole('admin', 'store_manager'), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        if (isNaN(id)) {
            return res.status(400).json({ error: "Invalid order ID" });
        }

        // Check if order exists
        const [existing] = await db.select().from(purchaseOrdersTable).where(eq(purchaseOrdersTable.id, id));
        if (!existing) {
            return res.status(404).json({ error: "Purchase order not found" });
        }

        // Optional: Only allow deleting draft orders (except for admin)
        if (existing.status !== 'draft' && req.user?.role !== 'admin') {
            return res.status(400).json({ error: "Only draft orders can be deleted" });
        }

        // Hard delete purchase order
        const [deleted] = await db
            .delete(purchaseOrdersTable)
            .where(eq(purchaseOrdersTable.id, id))
            .returning();

        res.json({ 
            success: true, 
            message: "Purchase order deleted successfully" 
        });

    } catch (error) {
        req.log.error({ err: error }, "Delete purchase order error");
        console.error("❌ Delete Purchase Order Error:", error);
        res.status(500).json({ 
            error: "Failed to delete purchase order",
            message: error.message 
        });
    }
});

export default router;
