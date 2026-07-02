import { Router } from "express";
import { db } from "@workspace/db";
import { feePaymentsTable, feeRecordsTable, feeStructuresTable, studentsTable, classesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireRole } from "../middlewares/auth";
import { resolveOwnStudentIds } from "../lib/scope";
import crypto from "crypto";
import Razorpay from "razorpay";

const router = Router();

const toMoney = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, n) : fallback;
};

const moneyString = (value) => toMoney(value).toFixed(2);

const normalizePaymentMethod = (value) => {
    const raw = String(value || "cash").trim().toLowerCase();
    const allowed = new Set(["cash", "upi", "card", "online"]);
    return allowed.has(raw) ? raw : "cash";
};

const paymentModeFor = (method) => method === "cash" ? "offline" : "online";

const generateReceiptNumber = () => {
    const date = new Date();
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return `REC-${yyyy}${mm}${dd}-${Date.now().toString().slice(-6)}`;
};

const normalizeTermType = (value) => {
    const raw = String(value || "Annual").trim();
    const map = {
        annual: "Annual",
        yearly: "Annual",
        monthly: "Monthly",
        month: "Monthly",
        termwise: "Term-wise",
        "term-wise": "Term-wise",
        terms: "Term-wise",
        term: "Term-wise",
        term1: "Term 1",
        "term 1": "Term 1",
        term2: "Term 2",
        "term 2": "Term 2",
        term3: "Term 3",
        "term 3": "Term 3",
    };
    return map[raw.toLowerCase()] || raw || "Annual";
};

const addMonths = (date, months) => {
    const d = new Date(date);
    const day = d.getDate();
    d.setMonth(d.getMonth() + months);
    if (d.getDate() !== day)
        d.setDate(0);
    return d.toISOString().split("T")[0];
};

const splitAmount = (amount, parts) => {
    const total = toMoney(amount);
    const each = total / parts;
    const values = [];
    let running = 0;
    for (let i = 0; i < parts; i++) {
        const value = i === parts - 1 ? total - running : Number(each.toFixed(2));
        values.push(value);
        running += value;
    }
    return values;
};

const buildInstallments = ({ grossAmount, concession, dueDate, termType }) => {
    const normalizedTerm = normalizeTermType(termType);
    const netAmount = Math.max(0, toMoney(grossAmount) - toMoney(concession));
    if (normalizedTerm === "Term-wise") {
        const grossParts = splitAmount(grossAmount, 3);
        const concessionParts = splitAmount(concession, 3);
        return grossParts.map((gross, index) => {
            const discount = concessionParts[index] ?? 0;
            return {
                amount: Math.max(0, Number((gross - discount).toFixed(2))),
                grossAmount: gross,
                concession: discount,
                dueDate: addMonths(dueDate, index * 4),
                installmentLabel: `Term ${index + 1}`,
                termType: normalizedTerm,
            };
        });
    }
    if (normalizedTerm !== "Monthly") {
        return [{
                amount: netAmount,
                grossAmount: toMoney(grossAmount),
                concession: toMoney(concession),
                dueDate,
                installmentLabel: normalizedTerm,
                termType: normalizedTerm,
            }];
    }
    const monthlyGross = toMoney(grossAmount) / 12;
    const monthlyConcession = toMoney(concession) / 12;
    const installments = [];
    let runningNet = 0;
    let runningGross = 0;
    let runningConcession = 0;
    for (let i = 0; i < 12; i++) {
        const isLast = i === 11;
        const gross = isLast ? toMoney(grossAmount) - runningGross : Number(monthlyGross.toFixed(2));
        const discount = isLast ? toMoney(concession) - runningConcession : Number(monthlyConcession.toFixed(2));
        const net = isLast ? netAmount - runningNet : Math.max(0, Number((gross - discount).toFixed(2)));
        runningGross += gross;
        runningConcession += discount;
        runningNet += net;
        installments.push({
            amount: net,
            grossAmount: gross,
            concession: discount,
            dueDate: addMonths(dueDate, i),
            installmentLabel: `Month ${i + 1}`,
            termType: normalizedTerm,
        });
    }
    return installments;
};

const duplicateKeyFor = ({ studentId, feeStructureId, academicYear, feeType, termType, installmentLabel }) => [
    Number(studentId),
    Number(feeStructureId),
    academicYear,
    String(feeType || "").trim().toLowerCase(),
    String(installmentLabel || normalizeTermType(termType) || "").trim().toLowerCase(),
].join("|");

const enrichFeeRecord = (fee, studentMap) => ({
    ...fee,
    amount: Number(fee.amount),
    grossAmount: fee.grossAmount ? Number(fee.grossAmount) : Number(fee.amount),
    paidAmount: fee.paidAmount ? Number(fee.paidAmount) : null,
    concession: fee.concession ? Number(fee.concession) : 0,
    balanceAmount: Math.max(0, Number(fee.amount) - Number(fee.paidAmount ?? 0)),
    studentName: studentMap[fee.studentId]?.name ?? `Student ${fee.studentId}`,
    studentAvatarUrl: studentMap[fee.studentId]?.avatarUrl ?? null,
});
router.get("/fees", requireRole("admin", "accountant", "clerk", "student", "parent"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const { studentId, status } = req.query;
        const students = await db.select().from(studentsTable);
        const studentMap = Object.fromEntries(students.map((s) => [s.id, { name: s.name, avatarUrl: s.avatarUrl }]));
        let all = await db.select().from(feeRecordsTable);
        // ── SCOPING ──
        if (me.role === "student" || me.role === "parent") {
            const ownIds = new Set(await resolveOwnStudentIds(me));
            if (studentId) {
                const sid = parseInt(String(studentId));
                if (!ownIds.has(sid))
                    return res.status(403).json({ error: "Forbidden" });
            }
            all = all.filter((f) => ownIds.has(f.studentId));
        }
        // admin, accountant, clerk → see all
        if (studentId)
            all = all.filter((f) => f.studentId === parseInt(String(studentId)));
        if (status)
            all = all.filter((f) => f.status === String(status));
        return res.json(all.map((f) => enrichFeeRecord(f, studentMap)));
    }
    catch (err) {
        req.log.error({ err }, "List fees error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/fees", requireRole("admin", "accountant", "parent"), async (req, res) => {
    try {
        const data = req.body;
        if (!data?.studentId || !data?.feeType || data?.amount === undefined || !data?.academicYear) {
            return res.status(400).json({ error: "Missing required fields: studentId, feeType, amount, academicYear" });
        }
        const grossAmount = toMoney(data.grossAmount ?? data.amount);
        const concession = toMoney(data.concession);
        const dueDate = data.dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
        const installments = buildInstallments({ grossAmount, concession, dueDate, termType: data.termType });
        if (data.feeStructureId) {
            const existing = await db.select().from(feeRecordsTable);
            const existingKeys = new Set(existing
                .filter((fee) => Number(fee.studentId) === Number(data.studentId) &&
                    Number(fee.feeStructureId) === Number(data.feeStructureId) &&
                    fee.academicYear === data.academicYear)
                .map((fee) => duplicateKeyFor(fee)));
            const duplicate = installments.find((installment) => existingKeys.has(duplicateKeyFor({
                studentId: data.studentId,
                feeStructureId: data.feeStructureId,
                academicYear: data.academicYear,
                feeType: data.feeType,
                termType: installment.termType,
                installmentLabel: data.installmentLabel || installment.installmentLabel,
            })));
            if (duplicate) {
                return res.status(409).json({ error: "Fee records already exist for this student, structure, academic year and installment." });
            }
        }
        const created = [];
        for (const installment of installments) {
            const [fee] = await db.insert(feeRecordsTable).values({
                studentId: Number(data.studentId),
                feeStructureId: data.feeStructureId ? Number(data.feeStructureId) : null,
                feeType: data.feeType,
                grossAmount: moneyString(installment.grossAmount),
                amount: moneyString(installment.amount),
                dueDate: installment.dueDate,
                academicYear: data.academicYear,
                status: "pending",
                concession: moneyString(installment.concession),
                concessionType: data.concessionType || (concession > 0 ? "Concession" : null),
                concessionReason: data.concessionReason || data.scholarshipName || null,
                installmentLabel: data.installmentLabel || installment.installmentLabel,
                termType: installment.termType,
            }).returning();
            created.push(fee);
        }
        const students = await db.select().from(studentsTable).where(eq(studentsTable.id, Number(data.studentId)));
        const studentMap = Object.fromEntries(students.map((s) => [s.id, { name: s.name, avatarUrl: s.avatarUrl }]));
        return res.status(201).json({
            ...enrichFeeRecord(created[0], studentMap),
            generatedRecords: created.length,
        });
    }
    catch (err) {
        req.log.error({ err }, "Create fee error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// =============================================
// RAZORPAY + PAYMENT ROUTES
// =============================================

// Create Razorpay Order
router.post("/fees/:id/razorpay/order", requireRole("admin", "accountant", "clerk", "student", "parent"), async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Not authenticated" });

        const me = req.user;
        const id = parseInt(String(req.params.id));

        const fees = await db.select().from(feeRecordsTable).where(eq(feeRecordsTable.id, id));
        const fee = fees[0];
        if (!fee) return res.status(404).json({ error: "Fee record not found" });

        // Scoping check
        if (!["admin", "accountant", "clerk"].includes(me.role)) {
            const ownIds = new Set(await resolveOwnStudentIds(me));
            if (!ownIds.has(fee.studentId)) return res.status(403).json({ error: "Forbidden" });
        }

        const outstanding = Math.max(0, toMoney(fee.amount) - toMoney(fee.paidAmount));
        if (outstanding <= 0) return res.status(400).json({ error: "Fee is already fully paid" });

        // Use custom amount from frontend if provided, otherwise use full outstanding amount
        const rawAmount = req.body.amount !== undefined && req.body.amount !== null ? String(req.body.amount).replace(/,/g, "").trim() : "";
        const payAmount = rawAmount ? toMoney(rawAmount) : outstanding;
        if (!Number.isFinite(payAmount) || payAmount <= 0 || payAmount > outstanding) {
            return res.status(400).json({ error: `Payment amount must be between 0 and ${outstanding}` });
        }

        const razorpay = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET,
        });

        const order = await razorpay.orders.create({
            amount: Math.round(payAmount * 100),
            currency: "INR",
            receipt: `fee_${fee.id}_${Date.now().toString().slice(-6)}`,
            payment_capture: 1,
        });

        return res.json({
            feeRecordId: fee.id,
            amount: payAmount,
            amountInPaise: Math.round(payAmount * 100),
            currency: "INR",
            razorpayOrderId: order.id,
            razorpayOrder: order,
        });
    } catch (err) {
        req.log.error({ err }, "Create Razorpay order error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

// Verify Razorpay Payment
router.post("/fees/razorpay/verify", requireRole("admin", "accountant", "clerk", "student", "parent"), async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;

        const { feeRecordId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};

        const id = parseInt(String(feeRecordId));
        if (!id || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const fees = await db.select().from(feeRecordsTable).where(eq(feeRecordsTable.id, id));
        const fee = fees[0];
        if (!fee) return res.status(404).json({ error: "Fee record not found" });

        if (!["admin", "accountant", "clerk"].includes(me.role)) {
            const ownIds = new Set(await resolveOwnStudentIds(me));
            if (!ownIds.has(fee.studentId)) return res.status(403).json({ error: "Forbidden" });
        }

        const secret = process.env.RAZORPAY_KEY_SECRET;
        if (!secret) return res.status(500).json({ error: "Razorpay not configured" });

        const payload = `${razorpay_order_id}|${razorpay_payment_id}`;
        const expectedSignature = crypto.createHmac("sha256", secret)
            .update(payload)
            .digest("hex");

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ error: "Invalid signature" });
        }

        const razorpay = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET,
        });
        const paymentDetails = await razorpay.payments.fetch(razorpay_payment_id);
        const paymentAmount = toMoney(paymentDetails.amount / 100);
        if (paymentAmount <= 0) {
            return res.status(400).json({ error: "Verified payment amount is invalid" });
        }

        const outstanding = Math.max(0, toMoney(fee.amount) - toMoney(fee.paidAmount));
        const actualAmount = Math.min(paymentAmount, outstanding);
        const receiptNumber = generateReceiptNumber();
        const totalPaid = toMoney(fee.paidAmount) + actualAmount;
        const status = totalPaid >= toMoney(fee.amount) ? "paid" : "partial";

        const [payment] = await db.insert(feePaymentsTable).values({
            feeRecordId: fee.id,
            studentId: fee.studentId,
            amount: actualAmount.toFixed(2),
            paymentMethod: "razorpay",
            paymentMode: "online",
            receiptNumber,
            transactionReference: razorpay_payment_id,
            notes: `Razorpay Order: ${razorpay_order_id}`,
            collectedBy: me.id,
        }).returning();

        const [updated] = await db.update(feeRecordsTable).set({
            paidAmount: Math.min(totalPaid, toMoney(fee.amount)).toFixed(2),
            paidDate: status === "paid" ? new Date().toISOString().split("T")[0] : null,
            status,
            paymentMethod: "razorpay",
            receiptNumber,
        }).where(eq(feeRecordsTable.id, id)).returning();

        const students = await db.select().from(studentsTable).where(eq(studentsTable.id, updated.studentId));
        const studentMap = Object.fromEntries(students.map(s => [s.id, { name: s.name, avatarUrl: s.avatarUrl }]));

        return res.json({
            ...enrichFeeRecord(updated, studentMap),
            payment: { ...payment, amount: Number(payment.amount) },
            receiptNumber,
        });
    } catch (err) {
        req.log.error({ err }, "Razorpay verify error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

// Manual / Cash Payment
router.post("/fees/:id/pay", requireRole("admin", "accountant", "clerk", "student", "parent"), async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Not authenticated" });

        const me = req.user;
        const id = parseInt(String(req.params.id));
        const data = req.body;

        const fees = await db.select().from(feeRecordsTable).where(eq(feeRecordsTable.id, id));
        const fee = fees[0];
        if (!fee) return res.status(404).json({ error: "Fee record not found" });

        if (!["admin", "accountant", "clerk"].includes(me.role)) {
            const ownIds = new Set(await resolveOwnStudentIds(me));
            if (!ownIds.has(fee.studentId)) return res.status(403).json({ error: "Forbidden" });
        }

        const paymentAmount = toMoney(data.amount);
        if (paymentAmount <= 0) return res.status(400).json({ error: "Payment amount must be greater than 0" });

        const outstanding = Math.max(0, toMoney(fee.amount) - toMoney(fee.paidAmount));
        if (outstanding <= 0) return res.status(400).json({ error: "Fee already fully paid" });
        if (paymentAmount > outstanding) {
            return res.status(400).json({ error: `Cannot exceed outstanding amount` });
        }

        const totalPaid = toMoney(fee.paidAmount) + paymentAmount;
        const receiptNumber = generateReceiptNumber();
        const status = totalPaid >= toMoney(fee.amount) ? "paid" : "partial";

        const [payment] = await db.insert(feePaymentsTable).values({
            feeRecordId: fee.id,
            studentId: fee.studentId,
            amount: paymentAmount.toFixed(2),
            paymentMethod: normalizePaymentMethod(data.paymentMethod),
            paymentMode: paymentModeFor(normalizePaymentMethod(data.paymentMethod)),
            receiptNumber,
            transactionReference: data.transactionReference || null,
            notes: data.notes || null,
            collectedBy: me.id,
        }).returning();

        const [updated] = await db.update(feeRecordsTable).set({
            paidAmount: Math.min(totalPaid, toMoney(fee.amount)).toFixed(2),
            paidDate: status === "paid" ? new Date().toISOString().split("T")[0] : null,
            status,
            paymentMethod: normalizePaymentMethod(data.paymentMethod),
            receiptNumber,
        }).where(eq(feeRecordsTable.id, id)).returning();

        const students = await db.select().from(studentsTable).where(eq(studentsTable.id, updated.studentId));
        const studentMap = Object.fromEntries(students.map(s => [s.id, { name: s.name, avatarUrl: s.avatarUrl }]));

        return res.json({
            ...enrichFeeRecord(updated, studentMap),
            payment: { ...payment, amount: Number(payment.amount) },
            receiptNumber,
        });
    } catch (err) {
        req.log.error({ err }, "Pay fee error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.get("/fees/:id/payments", requireRole("admin", "accountant", "clerk", "student", "parent"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const id = parseInt(String(req.params.id));
        const fees = await db.select().from(feeRecordsTable).where(eq(feeRecordsTable.id, id));
        const fee = fees[0];
        if (!fee)
            return res.status(404).json({ error: "Not found" });
        if (!["admin", "accountant", "clerk"].includes(me.role)) {
            const ownIds = new Set(await resolveOwnStudentIds(me));
            if (!ownIds.has(fee.studentId))
                return res.status(403).json({ error: "Forbidden" });
        }
        const payments = await db.select().from(feePaymentsTable).where(eq(feePaymentsTable.feeRecordId, id));
        return res.json(payments.map((p) => ({
            ...p,
            amount: Number(p.amount),
        })));
    }
    catch (err) {
        req.log.error({ err }, "List fee payments error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.get("/fee-structures", requireRole("admin", "accountant", "clerk", "teacher", "student", "parent"), async (req, res) => {
    try {
        const all = await db.select().from(feeStructuresTable);
        const classes = await db.select().from(classesTable);
        const classMap = Object.fromEntries(classes.map((c) => [c.id, `${c.grade}-${c.section}`]));
        return res.json(all.map((f) => {
            const comps = (f.components ?? []).map((c) => ({ ...c, amount: toMoney(c.amount) }));
            const total = comps.reduce((sum, c) => sum + c.amount, 0);
            return {
                ...f,
                className: classMap[f.classId] ?? `Class ${f.classId}`,
                totalAmount: total,
                components: comps,
            };
        }));
    }
    catch (err) {
        req.log.error({ err }, "List fee structures error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/fee-structures", requireRole("admin", "accountant"), async (req, res) => {
    try {
        const data = req.body;
        if (!data?.name || !data?.classId || !data?.academicYear || !Array.isArray(data?.components) || data.components.length === 0) {
            return res.status(400).json({ error: "Missing required fields: name, classId, academicYear, components" });
        }
        const components = data.components
            .map((c) => ({
            name: String(c.name || c.type || "").trim(),
            amount: toMoney(c.amount),
            optional: Boolean(c.optional),
        }))
            .filter((c) => c.name && c.amount > 0);
        if (components.length === 0) {
            return res.status(400).json({ error: "At least one valid fee component is required" });
        }
        const [fs] = await db.insert(feeStructuresTable).values({
            name: String(data.name).trim(),
            classId: Number(data.classId),
            academicYear: data.academicYear,
            components,
        }).returning();
        const classes = await db.select().from(classesTable).where(eq(classesTable.id, fs.classId));
        const cls = classes[0];
        const comps = (fs.components ?? []).map((c) => ({ ...c, amount: toMoney(c.amount) }));
        return res.status(201).json({
            ...fs,
            className: cls ? `${cls.grade}-${cls.section}` : `Class ${fs.classId}`,
            totalAmount: comps.reduce((sum, c) => sum + c.amount, 0),
            components: comps,
        });
    }
    catch (err) {
        req.log.error({ err }, "Create fee structure error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/fees/assign-structure", requireRole("admin", "accountant"), async (req, res) => {
    try {
        const { classId, feeStructureId, dueDate, termType, studentIds, studentAdjustments } = req.body;
        if (!classId || !feeStructureId || !dueDate) {
            return res.status(400).json({ error: "Missing required fields: classId, feeStructureId, dueDate" });
        }
        const [fs] = await db.select().from(feeStructuresTable).where(eq(feeStructuresTable.id, Number(feeStructureId)));
        if (!fs) {
            return res.status(404).json({ error: "Fee structure not found" });
        }
        if (Number(fs.classId) !== Number(classId)) {
            return res.status(400).json({ error: "Selected fee structure does not belong to the target class" });
        }
        const allClassStudents = await db.select().from(studentsTable).where(eq(studentsTable.classId, Number(classId)));
        const requestedStudentIds = Array.isArray(studentIds)
            ? new Set(studentIds.map((id) => Number(id)).filter((id) => Number.isFinite(id)))
            : null;
        const students = requestedStudentIds
            ? allClassStudents.filter((student) => requestedStudentIds.has(student.id))
            : allClassStudents;
        if (students.length === 0) {
            return res.status(400).json({ error: "No students found for the selected assignment scope" });
        }
        const comps = (fs.components ?? []).map((c) => ({ ...c, amount: toMoney(c.amount) })).filter((c) => c.name && c.amount > 0);
        const existingRecords = await db.select().from(feeRecordsTable);
        const existingKeys = new Set(existingRecords
            .filter((fee) => Number(fee.feeStructureId) === Number(fs.id) && fee.academicYear === fs.academicYear)
            .map((fee) => duplicateKeyFor(fee)));
        const adjustmentsByStudent = Object.fromEntries((Array.isArray(studentAdjustments) ? studentAdjustments : [])
            .map((a) => [Number(a.studentId), a])
            .filter(([studentId]) => Number.isFinite(studentId)));
        let count = 0;
        let skipped = 0;
        for (const student of students) {
            const adjustment = adjustmentsByStudent[student.id] ?? {};
            const componentConcessions = adjustment.componentConcessions ?? {};
            for (const comp of comps) {
                const concession = toMoney(componentConcessions[comp.name] ?? adjustment.concession);
                const installments = buildInstallments({
                    grossAmount: comp.amount,
                    concession,
                    dueDate,
                    termType,
                });
                for (const installment of installments) {
                    const duplicateKey = duplicateKeyFor({
                        studentId: student.id,
                        feeStructureId: fs.id,
                        academicYear: fs.academicYear,
                        feeType: comp.name,
                        termType: installment.termType,
                        installmentLabel: installment.installmentLabel,
                    });
                    if (existingKeys.has(duplicateKey)) {
                        skipped++;
                        continue;
                    }
                    await db.insert(feeRecordsTable).values({
                        studentId: student.id,
                        feeStructureId: fs.id,
                        feeType: comp.name,
                        grossAmount: moneyString(installment.grossAmount),
                        amount: moneyString(installment.amount),
                        dueDate: installment.dueDate,
                        academicYear: fs.academicYear,
                        status: "pending",
                        termType: installment.termType,
                        installmentLabel: installment.installmentLabel,
                        concession: moneyString(installment.concession),
                        concessionType: adjustment.concessionType || adjustment.scholarshipName || (concession > 0 ? "Concession" : null),
                        concessionReason: adjustment.concessionReason || adjustment.scholarshipName || null,
                    });
                    existingKeys.add(duplicateKey);
                    count++;
                }
            }
        }
        return res.status(201).json({
            message: `Successfully assigned structures. Generated ${count} fee records for ${students.length} students.${skipped ? ` Skipped ${skipped} duplicate records.` : ""}`,
            generated: count,
            skipped,
            students: students.length,
        });
    }
    catch (err) {
        req.log.error({ err }, "Assign fee structure error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/fees/apply-late-fines", requireRole("admin", "accountant"), async (req, res) => {
    try {
        const { sql } = await import("drizzle-orm");
        const todayStr = new Date().toISOString().split("T")[0];
        const allFees = await db.select().from(feeRecordsTable);
        const fineRefIds = new Set();
        for (const f of allFees) {
            if (f.feeType && f.feeType.startsWith("Late Fine (Ref: #")) {
                const match = f.feeType.match(/Late Fine \(Ref: #(\d+)\)/);
                if (match) {
                    fineRefIds.add(parseInt(match[1]));
                }
            }
        }
        const toFine = allFees.filter(f => 
            (f.status === "pending" || f.status === "overdue") &&
            f.dueDate && f.dueDate < todayStr &&
            !fineRefIds.has(f.id) &&
            !(f.feeType && f.feeType.startsWith("Late Fine (Ref: #"))
        );
        const createdFines = [];
        for (const fee of toFine) {
            await db.update(feeRecordsTable).set({ status: "overdue" }).where(eq(feeRecordsTable.id, fee.id));
            const [fine] = await db.insert(feeRecordsTable).values({
                studentId: fee.studentId,
                feeType: `Late Fine (Ref: #${fee.id})`,
                amount: "250.00",
                dueDate: todayStr,
                academicYear: fee.academicYear,
                status: "pending",
                termType: fee.termType ?? "Annual",
                concession: "0",
            }).returning();
            createdFines.push(fine);
        }
        return res.json({ message: `Late fine check executed. Applied late fines to ${createdFines.length} overdue records.`, count: createdFines.length });
    }
    catch (err) {
        req.log.error({ err }, "Apply late fines error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.get("/fees/reports", requireRole("admin", "accountant"), async (req, res) => {
    try {
        const allFees = await db.select().from(feeRecordsTable);
        const students = await db.select().from(studentsTable);
        const classes = await db.select().from(classesTable);
        const classMap = Object.fromEntries(classes.map(c => [c.id, `${c.grade}-${c.section}`]));
        const studentToClassId = Object.fromEntries(students.map(s => [s.id, s.classId]));
        let totalGenerated = 0;
        let totalCollected = 0;
        let totalOverdue = 0;
        const classBreakdown = {};
        const categoryBreakdown = {};
        for (const fee of allFees) {
            const amount = Number(fee.amount);
            const paid = fee.paidAmount ? Number(fee.paidAmount) : 0;
            const status = fee.status;
            totalGenerated += amount;
            totalCollected += paid;
            if (status === "overdue") {
                totalOverdue += (amount - paid);
            }
            const classId = studentToClassId[fee.studentId];
            if (classId) {
                if (!classBreakdown[classId]) {
                    classBreakdown[classId] = {
                        className: classMap[classId] ?? `Class ${classId}`,
                        generated: 0,
                        collected: 0,
                        overdue: 0
                    };
                }
                classBreakdown[classId].generated += amount;
                classBreakdown[classId].collected += paid;
                if (status === "overdue") {
                    classBreakdown[classId].overdue += (amount - paid);
                }
            }
            const category = fee.feeType || "Other";
            if (!categoryBreakdown[category]) {
                categoryBreakdown[category] = {
                    category,
                    generated: 0,
                    collected: 0,
                    overdue: 0
                };
            }
            categoryBreakdown[category].generated += amount;
            categoryBreakdown[category].collected += paid;
            if (status === "overdue") {
                categoryBreakdown[category].overdue += (amount - paid);
            }
        }
        return res.json({
            summary: {
                totalGenerated,
                totalCollected,
                totalOverdue,
                collectionRate: totalGenerated > 0 ? (totalCollected / totalGenerated) * 100 : 0
            },
            classBreakdown: Object.values(classBreakdown),
            categoryBreakdown: Object.values(categoryBreakdown)
        });
    }
    catch (err) {
        req.log.error({ err }, "Get reports error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
export default router;
