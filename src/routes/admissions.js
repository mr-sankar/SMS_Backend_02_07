import { Router } from "express";
import { db } from "@workspace/db";
import { admissionsTable, feeRecordsTable, admissionInquiriesTable, admissionFormPurchasesTable, studentsTable, usersTable, classesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireRole, requireAuth } from "../middlewares/auth";
import { hashPassword } from "../lib/password";
const router = Router();

function parseAdmissionDocuments(value) {
    if (!value)
        return [];
    try {
        const docs = JSON.parse(value);
        return Array.isArray(docs) ? docs : [];
    }
    catch {
        return [];
    }
}

function getApplicationClassGrade(applyingForClass) {
    const raw = String(applyingForClass ?? "").trim().replace(/^class\s+/i, "");
    if (raw.toLowerCase() === "lkg")
        return "LKG";
    if (raw.toLowerCase() === "ukg")
        return "UKG";
    const match = raw.match(/\d+/);
    return match ? match[0] : "";
}

function getClassLabel(applyingForClass) {
    const grade = getApplicationClassGrade(applyingForClass);
    if (grade === "LKG" || grade === "UKG")
        return grade;
    return grade ? `Class ${grade}` : "Class";
}

function getAge(dateOfBirth) {
    const dob = new Date(dateOfBirth);
    if (Number.isNaN(dob.getTime()))
        return null;
    const now = new Date();
    let age = now.getFullYear() - dob.getFullYear();
    const beforeBirthday = now.getMonth() < dob.getMonth() ||
        (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate());
    if (beforeBirthday)
        age -= 1;
    return age;
}

function getAgeRangeForClass(applyingForClass) {
    const grade = getApplicationClassGrade(applyingForClass);
    if (grade === "LKG")
        return { min: 3, max: 4 };
    if (grade === "UKG")
        return { min: 4, max: 5 };
    const n = Number(grade);
    if (!Number.isFinite(n))
        return null;
    return { min: n + 4, max: n + 5 };
}

function validateAdmissionDob(dateOfBirth, applyingForClass) {
    if (!dateOfBirth)
        return "Date of birth is required";
    const today = new Date().toISOString().split("T")[0];
    if (String(dateOfBirth) > today)
        return "Future dates are not allowed for date of birth";
    const range = getAgeRangeForClass(applyingForClass);
    const age = getAge(dateOfBirth);
    if (range && age !== null && (age < range.min || age > range.max)) {
        return `${getClassLabel(applyingForClass)} applicants must be ${range.min}-${range.max} years old`;
    }
    return "";
}

async function findClassForAdmission(admission) {
    const grade = getApplicationClassGrade(admission.applyingForClass);
    if (!grade)
        return null;
    const allClasses = await db.select().from(classesTable);
    return allClasses.find((c) => String(c.grade) === grade) ?? null;
}

function canManageAdmissionDocuments(user, admission) {
    if (!user)
        return false;
    if (user.role === "admin" || user.role === "clerk")
        return true;
    return (user.email && admission.parentEmail === user.email) ||
        (user.phone && admission.parentPhone === user.phone);
}
router.get("/admissions", requireRole("admin", "clerk", "parent"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const { status } = req.query;
        let all = await db.select().from(admissionsTable);
        // Admissions data is sensitive: admin/clerk see all; parents and other roles see only
        // applications they themselves filed (matched by the authoritative
        // parentEmail / parentPhone columns on the admissions row).
        if (me.role !== "admin" && me.role !== "clerk") {
            all = all.filter((a) => (me.email && a.parentEmail === me.email) ||
                (me.phone && a.parentPhone === me.phone));
        }
        if (status)
            all = all.filter((a) => a.status === String(status));
        return res.json(all.map((a) => ({
            ...a,
            appliedAt: a.appliedAt.toISOString(),
            reviewedAt: a.reviewedAt?.toISOString() ?? null,
        })));
    }
    catch (err) {
        req.log.error({ err }, "List admissions error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/admissions", requireRole("admin", "clerk", "parent"), async (req, res) => {
    try {
        const data = req.body;
        const dobError = validateAdmissionDob(data.dateOfBirth, data.applyingForClass);
        if (dobError) {
            return res.status(400).json({ error: dobError });
        }
        const [admission] = await db.insert(admissionsTable).values({
            applicantName: data.applicantName,
            dateOfBirth: data.dateOfBirth,
            gender: data.gender,
            applyingForClass: data.applyingForClass,
            previousSchool: data.previousSchool ?? null,
            parentName: data.parentName,
            parentEmail: data.parentEmail,
            parentPhone: data.parentPhone,
            address: data.address ?? null,
            documents: data.documents ?? null,
            academicYear: data.academicYear ?? null,
            status: "pending",
        }).returning();
        return res.status(201).json({ ...admission, appliedAt: admission.appliedAt.toISOString(), reviewedAt: null });
    }
    catch (err) {
        req.log.error({ err }, "Create admission error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ─── ADMISSION INQUIRIES ───────────────────────────────────────────────────
router.post("/admissions/inquiries", async (req, res) => {
    try {
        const data = req.body;
        if (!data.applicantName || !data.applyingForClass || !data.parentName || !data.parentEmail || !data.parentPhone) {
            return res.status(400).json({ error: "Missing required fields" });
        }
        const [inquiry] = await db.insert(admissionInquiriesTable).values({
            applicantName: data.applicantName,
            applyingForClass: data.applyingForClass,
            parentName: data.parentName,
            parentEmail: data.parentEmail,
            parentPhone: data.parentPhone,
            message: data.message ?? null,
            source: data.source ?? "Website",
            status: "new",
        }).returning();
        return res.status(201).json(inquiry);
    }
    catch (err) {
        req.log.error({ err }, "Create admission inquiry error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/admissions/inquiries", requireAuth, async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        
        let all = await db.select().from(admissionInquiriesTable);
        if (req.user.role !== "admin" && req.user.role !== "clerk") {
            all = all.filter((a) => (req.user.email && a.parentEmail === req.user.email) ||
                (req.user.phone && a.parentPhone === req.user.phone));
        }
        return res.json(all);
    }
    catch (err) {
        req.log.error({ err }, "List admission inquiries error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ─── ADMISSION FORM PURCHASES ──────────────────────────────────────────────
router.post("/admissions/form-purchases", requireAuth, async (req, res) => {
    try {
        const data = req.body;
        if (!data.applicantName || !data.applyingForClass || !data.parentName || !data.parentEmail || !data.parentPhone || !data.mode || !data.paymentMethod) {
            return res.status(400).json({ error: "Missing required fields" });
        }
        const amount = String(data.amount || "500");
        const paymentStatus = data.mode === "offline" || req.user.role === "admin" || req.user.role === "clerk" ? "paid" : "pending";
        const transactionId = data.transactionId || (data.mode === "online" ? `TXN-${Date.now()}` : `OFFLINE-${Math.floor(1000 + Math.random() * 9000)}`);
        
        const [purchase] = await db.insert(admissionFormPurchasesTable).values({
            applicantName: data.applicantName,
            applyingForClass: data.applyingForClass,
            parentName: data.parentName,
            parentEmail: data.parentEmail,
            parentPhone: data.parentPhone,
            mode: data.mode,
            paymentMethod: data.paymentMethod,
            paymentStatus,
            amount,
            transactionId,
        }).returning();
        return res.status(201).json(purchase);
    }
    catch (err) {
        req.log.error({ err }, "Create admission form purchase error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/admissions/form-purchases", requireAuth, async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        
        let all = await db.select().from(admissionFormPurchasesTable);
        if (req.user.role !== "admin" && req.user.role !== "clerk") {
            all = all.filter((a) => (req.user.email && a.parentEmail === req.user.email) ||
                (req.user.phone && a.parentPhone === req.user.phone));
        }
        return res.json(all);
    }
    catch (err) {
        req.log.error({ err }, "List admission form purchases error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.patch("/admissions/form-purchases/:id", requireRole("admin", "clerk"), async (req, res) => {
    try {
        const data = req.body;
        const upd = {};
        if (data.paymentStatus !== undefined)
            upd.paymentStatus = data.paymentStatus;
        if (data.transactionId !== undefined)
            upd.transactionId = data.transactionId;
        const [updated] = await db.update(admissionFormPurchasesTable).set(upd).where(eq(admissionFormPurchasesTable.id, parseInt(String(req.params.id)))).returning();
        if (!updated)
            return res.status(404).json({ error: "Not found" });
        return res.json(updated);
    }
    catch (err) {
        req.log.error({ err }, "Update admission form purchase error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/admissions/:id", requireAuth, async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const all = await db.select().from(admissionsTable).where(eq(admissionsTable.id, parseInt(String(req.params.id))));
        if (!all[0])
            return res.status(404).json({ error: "Not found" });
        const a = all[0];
        // Parents and other non-staff roles may only see admissions they filed
        if (me.role !== "admin" && me.role !== "clerk") {
            const matchEmail = !!(me.email && a.parentEmail === me.email);
            const matchPhone = !!(me.phone && a.parentPhone === me.phone);
            if (!matchEmail && !matchPhone)
                return res.status(403).json({ error: "Forbidden" });
        }
        return res.json({ ...a, appliedAt: a.appliedAt.toISOString(), reviewedAt: a.reviewedAt?.toISOString() ?? null });
    }
    catch (err) {
        req.log.error({ err }, "Get admission error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// Approval — ADMIN ONLY (clerk previously had access; now blocked per bug list)
router.patch("/admissions/:id", requireRole("admin"), async (req, res) => {
    try {
        const data = req.body;
        const upd = {};
        if (data.status !== undefined)
            upd.status = data.status;
        if (data.remarks !== undefined)
            upd.remarks = data.remarks;
        if (data.testStatus !== undefined)
            upd.testStatus = data.testStatus;
        if (data.testDate !== undefined)
            upd.testDate = data.testDate;
        if (data.testScore !== undefined)
            upd.testScore = data.testScore;
        if (data.interviewScore !== undefined)
            upd.interviewScore = data.interviewScore;
        if (data.meritListIncluded !== undefined)
            upd.meritListIncluded = data.meritListIncluded;
        if (data.meritRank !== undefined)
            upd.meritRank = data.meritRank;
        if (data.status === "approved" || data.status === "rejected")
            upd.reviewedAt = new Date();
        if (data.status === "approved") {
            const [current] = await db.select().from(admissionsTable).where(eq(admissionsTable.id, parseInt(String(req.params.id))));
            if (!current)
                return res.status(404).json({ error: "Not found" });
            const docs = parseAdmissionDocuments(current.documents);
            const hasBlockedDocument = docs.some((d) => (d.status || "pending") !== "verified");
            if (hasBlockedDocument) {
                return res.status(400).json({ error: "All uploaded documents must be verified before approval" });
            }
        }
        const [updated] = await db.update(admissionsTable).set(upd).where(eq(admissionsTable.id, parseInt(String(req.params.id)))).returning();
        if (!updated)
            return res.status(404).json({ error: "Not found" });
        // ── AUTO-GENERATE ADMISSION FEE on approval ──
        if (data.status === "approved") {
            const existingFee = await db.select().from(feeRecordsTable);
            const alreadyHasAdmissionFee = existingFee.some((f) => f.feeType === "admission" && f.studentId === -updated.id);
            if (!alreadyHasAdmissionFee) {
                // Insert a placeholder fee tied to the parent email (until student record is created)
                const dueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
                try {
                    await db.insert(feeRecordsTable).values({
                        studentId: -updated.id, // negative => admission-stage fee, replace on student creation
                        feeType: "admission",
                        amount: "5000",
                        dueDate,
                        academicYear: new Date().getFullYear() + "-" + String(new Date().getFullYear() + 1).slice(-2),
                        status: "pending",
                    });
                }
                catch {
                    // Tolerated — schema may reject negative IDs in stricter setups
                }
            }
        }
        return res.json({ ...updated, appliedAt: updated.appliedAt.toISOString(), reviewedAt: updated.reviewedAt?.toISOString() ?? null });
    }
    catch (err) {
        req.log.error({ err }, "Update admission error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// Manually generate the admission fee for an already-approved admission (admin-only).
// Useful when the auto-trigger on PATCH didn't run, or when an existing fee was deleted.
router.post("/admissions/:id/generate-fee", requireRole("admin"), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        const all = await db.select().from(admissionsTable).where(eq(admissionsTable.id, id));
        const a = all[0];
        if (!a)
            return res.status(404).json({ error: "Not found" });
        if (a.status !== "approved")
            return res.status(400).json({ error: "Admission must be approved first" });
        const existingFee = await db.select().from(feeRecordsTable);
        const already = existingFee.some((f) => f.feeType === "admission" && f.studentId === -a.id);
        if (already)
            return res.status(409).json({ error: "Admission fee already generated" });
        const dueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
        const amount = 5000;
        const [fee] = await db.insert(feeRecordsTable).values({
            studentId: -a.id,
            feeType: "admission",
            amount: String(amount),
            dueDate,
            academicYear: new Date().getFullYear() + "-" + String(new Date().getFullYear() + 1).slice(-2),
            status: "pending",
        }).returning();
        return res.status(201).json({ amount, feeId: fee?.id ?? null });
    }
    catch (err) {
        req.log.error({ err }, "Generate admission fee error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
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
// Mark fee paid and convert applicant → student (admin-only)
router.post("/admissions/:id/enrol", requireRole("admin"), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        const all = await db.select().from(admissionsTable).where(eq(admissionsTable.id, id));
        const a = all[0];
        if (!a)
            return res.status(404).json({ error: "Not found" });
        if (a.status !== "approved")
            return res.status(400).json({ error: "Admission must be approved before enrolment" });
        const matchedClass = await findClassForAdmission(a);
        const classId = req.body.classId ? parseInt(String(req.body.classId)) : matchedClass?.id ?? null;
        if (!classId) {
            return res.status(400).json({ error: "Missing required classId for student enrolment" });
        }
        const clsRows = await db.select().from(classesTable).where(eq(classesTable.id, classId));
        const targetClass = clsRows[0];
        if (!targetClass) {
            return res.status(404).json({ error: "Class not found" });
        }
        const year = new Date().getFullYear();
        const prefix = `STU${year}`;
        const existing = await db.select({ rollNumber: studentsTable.rollNumber }).from(studentsTable);
        const seqNums = existing
            .map((s) => s.rollNumber)
            .filter((r) => r.startsWith(prefix))
            .map((r) => parseInt(r.slice(prefix.length), 10))
            .filter((n) => !Number.isNaN(n));
        const nextSeq = (seqNums.length ? Math.max(...seqNums) : 0) + 1;
        const rollNumber = `${prefix}${String(nextSeq).padStart(3, "0")}`;
        const base = slugifyName(a.applicantName);
        const suffix = rollNumber.slice(-3);
        let username = `${base}${suffix}`;
        let attempt = 0;
        while ((await db.select().from(usersTable).where(eq(usersTable.username, username))).length > 0) {
            attempt += 1;
            username = `${base}${suffix}${attempt}`;
            if (attempt > 50) {
                return res.status(500).json({ error: "Could not allocate unique username" });
            }
        }
        const password = generatePassword();
        const passwordHash = await hashPassword(password);
        const now = new Date();
        const currentYear = now.getFullYear();
        const defaultAcademicYear = `${currentYear} - ${currentYear + 1}`;
        const { student, userId } = await db.transaction(async (tx) => {
            const [s] = await tx.insert(studentsTable).values({
                name: a.applicantName,
                rollNumber,
                classId,
                gender: a.gender,
                dateOfBirth: a.dateOfBirth ?? null,
                phone: a.parentPhone ?? null,
                email: a.parentEmail ?? null,
                parentName: a.parentName ?? null,
                parentPhone: a.parentPhone ?? null,
                address: a.address ?? null,
                admissionDate: new Date().toISOString().split("T")[0],
                academicYear: a.academicYear ?? defaultAcademicYear,
                status: "active",
            }).returning();
            const [u] = await tx.insert(usersTable).values({
                username,
                password: passwordHash,
                role: "student",
                name: a.applicantName,
                email: a.parentEmail || `${username}@student.local`,
                phone: a.parentPhone ?? null,
            }).returning();
            const [linked] = await tx
                .update(studentsTable)
                .set({ userId: u.id })
                .where(eq(studentsTable.id, s.id))
                .returning();
            await tx
                .update(admissionsTable)
                .set({ status: "enrolled", reviewedAt: new Date() })
                .where(eq(admissionsTable.id, id));
            await tx
                .update(feeRecordsTable)
                .set({ studentId: linked.id })
                .where(eq(feeRecordsTable.studentId, -id));
            return { student: linked, userId: u.id };
        });
        return res.status(201).json({
            student,
            userId,
            credentials: { studentId: rollNumber, username, password },
        });
    }
    catch (err) {
        req.log.error({ err }, "Enrol admission error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// Upload or replace a document on an existing admission. Parents can resubmit
// their rejected documents; staff can attach documents from the admin panel.
router.post("/admissions/:id/documents", requireAuth, async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        const all = await db.select().from(admissionsTable).where(eq(admissionsTable.id, id));
        const a = all[0];
        if (!a)
            return res.status(404).json({ error: "Not found" });
        if (!canManageAdmissionDocuments(req.user, a))
            return res.status(403).json({ error: "Forbidden" });
        const incoming = Array.isArray(req.body?.documents) ? req.body.documents : [];
        if (!incoming.length) {
            return res.status(400).json({ error: "No documents supplied" });
        }
        let docs = parseAdmissionDocuments(a.documents);
        for (const doc of incoming) {
            if (!doc?.name || !doc?.dataUrl) {
                return res.status(400).json({ error: "Each document requires a name and dataUrl" });
            }
            const replacementFor = doc.replacementFor ? String(doc.replacementFor) : null;
            const nextDoc = {
                ...doc,
                id: doc.id || `${Date.now()}-${doc.name}`,
                docType: doc.docType || doc.name,
                status: "pending",
                remarks: "",
            };
            if (replacementFor) {
                let replaced = false;
                docs = docs.map((d) => {
                    if (String(d.id || d.name) === replacementFor) {
                        replaced = true;
                        return { ...nextDoc, id: d.id || nextDoc.id };
                    }
                    return d;
                });
                if (!replaced)
                    docs.push(nextDoc);
            }
            else {
                docs.push(nextDoc);
            }
        }
        const [updated] = await db.update(admissionsTable).set({ documents: JSON.stringify(docs) }).where(eq(admissionsTable.id, id)).returning();
        return res.status(201).json({ ...updated, appliedAt: updated.appliedAt.toISOString(), reviewedAt: updated.reviewedAt?.toISOString() ?? null });
    }
    catch (err) {
        req.log.error({ err }, "Upload admission document error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// Verify / reject a single document in admissions documents list
router.patch("/admissions/:id/documents/:docId", requireRole("admin", "clerk"), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        const { docId } = req.params;
        const { status, remarks } = req.body;
        if (!["verified", "rejected", "pending"].includes(status)) {
            return res.status(400).json({ error: "Invalid document status" });
        }
        const all = await db.select().from(admissionsTable).where(eq(admissionsTable.id, id));
        const a = all[0];
        if (!a)
            return res.status(404).json({ error: "Not found" });
        let docs = parseAdmissionDocuments(a.documents);
        let found = false;
        docs = docs.map((d) => {
            if (d.id === docId || d.name === docId) {
                found = true;
                return { ...d, status, remarks: remarks ?? d.remarks ?? null };
            }
            return d;
        });
        if (!found) {
            return res.status(404).json({ error: "Document not found" });
        }
        const [updated] = await db.update(admissionsTable).set({ documents: JSON.stringify(docs) }).where(eq(admissionsTable.id, id)).returning();
        return res.json({ ...updated, appliedAt: updated.appliedAt.toISOString(), reviewedAt: updated.reviewedAt?.toISOString() ?? null });
    }
    catch (err) {
        req.log.error({ err }, "Verify document error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ─── ADMISSION DELETE ───────────────────────────────────────────────────
router.delete("/admissions/:id", requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        
        if (!req.user) {
            return res.status(401).json({ error: "Not authenticated" });
        }
        
        // Only admin can delete applications
        if (req.user.role !== "admin") {
            return res.status(403).json({ error: "Forbidden: Only admins can delete applications" });
        }
        
        // Check if the admission exists
        const [existingAdmission] = await db
            .select()
            .from(admissionsTable)
            .where(eq(admissionsTable.id, parseInt(id)));
        
        if (!existingAdmission) {
            return res.status(404).json({ error: "Application not found" });
        }
        
        // Optional: Check if application is already enrolled and prevent deletion
        if (existingAdmission.status === "enrolled") {
            return res.status(400).json({ 
                error: "Cannot delete an enrolled application. Please unenroll the student first." 
            });
        }
        
        // Delete the admission
        await db
            .delete(admissionsTable)
            .where(eq(admissionsTable.id, parseInt(id)));
        
        // Optional: Also delete any associated documents from storage
        // If you have documents stored in a separate table or filesystem
        // You might want to clean those up here
        
        req.log.info({ admissionId: id, deletedBy: req.user.id }, "Admission application deleted");
        return res.status(200).json({ 
            success: true, 
            message: "Application deleted successfully",
            deletedId: id 
        });
    }
    catch (err) {
        req.log.error({ err, admissionId: req.params.id }, "Delete admission error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
export default router;
