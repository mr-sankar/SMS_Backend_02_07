import { Router } from "express";
import { db } from "@workspace/db";
import { 
    staffTable, 
    usersTable, 
    leaveRequestsTable, 
    salaryMonthsTable, 
    staffSalariesTable, 
    payslipsTable, 
    salaryNotificationsTable,
    schoolSettingsTable
} from "@workspace/db";
import { eq, and, or, desc, sql } from "drizzle-orm";
import { requireRole, requireAuth } from "../middlewares/auth";
import PDFDocument from "pdfkit";
import { logger } from "../lib/logger";
const router = Router();
// Helper: Calculate overlap leave days in a month
function getLeaveDaysInMonth(startDateStr, endDateStr, month, year) {
    const start = new Date(startDateStr);
    const end = new Date(endDateStr);
    
    // Target month boundaries
    const targetStart = new Date(year, month - 1, 1);
    const targetEnd = new Date(year, month, 0); // Last day of month
    
    // Find intersection
    const overlapStart = new Date(Math.max(start, targetStart));
    const overlapEnd = new Date(Math.min(end, targetEnd));
    
    if (overlapStart <= overlapEnd) {
        const diffTime = Math.abs(overlapEnd - overlapStart);
        return Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
    }
    return 0;
}
// Helper: Number to Words (Indian Rupee style)
function numberToWords(num) {
    if (num === 0) return "Zero";
    
    const parts = String(Number(num).toFixed(2)).split(".");
    const rupees = parseInt(parts[0], 10);
    const paise = parseInt(parts[1], 10);
    
    const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", 
                  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
    const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
    
    function convertLessThanOneThousand(n) {
        if (n === 0) return "";
        let str = "";
        if (n >= 100) {
            str += ones[Math.floor(n / 100)] + " Hundred ";
            n %= 100;
        }
        if (n >= 20) {
            str += tens[Math.floor(n / 10)] + " ";
            n %= 10;
        }
        if (n > 0) {
            str += ones[n] + " ";
        }
        return str.trim();
    }
    
    function convertRupees(n) {
        if (n === 0) return "Zero";
        let str = "";
        if (n >= 10000000) {
            str += convertLessThanOneThousand(Math.floor(n / 10000000)) + " Crore ";
            n %= 10000000;
        }
        if (n >= 100000) {
            str += convertLessThanOneThousand(Math.floor(n / 100000)) + " Lakh ";
            n %= 100000;
        }
        if (n >= 1000) {
            str += convertLessThanOneThousand(Math.floor(n / 1000)) + " Thousand ";
            n %= 1000;
        }
        if (n > 0) {
            str += convertLessThanOneThousand(n);
        }
        return str.trim();
    }
    
    let words = "Rupees " + convertRupees(rupees);
    if (paise > 0) {
        words += " and " + convertLessThanOneThousand(paise) + " Paise";
    }
    words += " Only";
    return words;
}
// Recalculates details for a staff salary entry
function calculateSalaryDetails(gross, leaveDays) {
    const grossVal = parseFloat(String(gross || 0));
    const basicVal = Math.round((grossVal * 0.5) * 100) / 100;
    const pfVal = Math.round((basicVal * 0.12) * 100) / 100;
    const ptVal = 200.00;
    const leaveDaysVal = parseFloat(String(leaveDays || 0));
    const dailySalary = grossVal / 26;
    const leaveDeductionVal = Math.round((dailySalary * leaveDaysVal) * 100) / 100;
    const totalDeductionVal = Math.round((pfVal + ptVal + leaveDeductionVal) * 100) / 100;
    const netVal = Math.round((grossVal - totalDeductionVal) * 100) / 100;
    return {
        grossSalary: String(grossVal.toFixed(2)),
        basicSalary: String(basicVal.toFixed(2)),
        pf: String(pfVal.toFixed(2)),
        pt: String(ptVal.toFixed(2)),
        leaveDays: String(leaveDaysVal.toFixed(2)),
        leaveDeduction: String(leaveDeductionVal.toFixed(2)),
        totalDeduction: String(totalDeductionVal.toFixed(2)),
        netSalary: String(netVal.toFixed(2))
    };
}

async function getSchoolName() {
    const [settings] = await db.select().from(schoolSettingsTable).where(eq(schoolSettingsTable.id, 1));
    return settings?.name?.trim() || "Nexus Academy";
}

// 1. POST /api/salary/generate: Generate salary sheet
router.post("/salary/generate", requireRole("admin", "accountant"), async (req, res) => {
    try {
        const { month, year } = req.body;
        if (!month || !year) {
            return res.status(400).json({ error: "Month and Year are required" });
        }
        const mNum = parseInt(String(month), 10);
        const yNum = parseInt(String(year), 10);
        // Fetch all active staff
        const allStaff = await db.select().from(staffTable).where(eq(staffTable.status, "active"));
        
        let generatedCount = 0;
        let skippedCount = 0;
        for (const staff of allStaff) {
            // Check if record already exists for this staff in target month/year
            const existing = await db.select()
                .from(staffSalariesTable)
                .where(
                    and(
                        eq(staffSalariesTable.staffId, staff.id),
                        eq(staffSalariesTable.month, mNum),
                        eq(staffSalariesTable.year, yNum)
                    )
                );
            if (existing.length > 0) {
                skippedCount++;
                continue;
            }
            // Calculate leave days from leaveRequestsTable
            const approvedLeaves = await db.select()
                .from(leaveRequestsTable)
                .where(
                    and(
                        eq(leaveRequestsTable.applicantType, "staff"),
                        eq(leaveRequestsTable.applicantId, staff.id),
                        eq(leaveRequestsTable.status, "approved")
                    )
                );
            let totalLeaveDays = 0;
            for (const leave of approvedLeaves) {
                totalLeaveDays += getLeaveDaysInMonth(leave.startDate, leave.endDate, mNum, yNum);
            }
            const gross = staff.monthlySalary ?? staff.salary ?? "0";
            const calculations = calculateSalaryDetails(gross, totalLeaveDays);
            await db.insert(staffSalariesTable).values({
                staffId: staff.id,
                grossSalary: calculations.grossSalary,
                basicSalary: calculations.basicSalary,
                pf: calculations.pf,
                pt: calculations.pt,
                leaveDays: calculations.leaveDays,
                leaveDeduction: calculations.leaveDeduction,
                totalDeduction: calculations.totalDeduction,
                netSalary: calculations.netSalary,
                paymentStatus: "Pending",
                month: mNum,
                year: yNum
            });
            generatedCount++;
        }
        // Log run in salary_months
        const existingMonth = await db.select()
            .from(salaryMonthsTable)
            .where(
                and(
                    eq(salaryMonthsTable.month, mNum),
                    eq(salaryMonthsTable.year, yNum)
                )
            );
        if (existingMonth.length === 0) {
            await db.insert(salaryMonthsTable).values({
                month: mNum,
                year: yNum,
                status: "generated"
            });
        }
        return res.json({
            success: true,
            message: `Salary sheet generated. Generated: ${generatedCount}, Skipped: ${skippedCount}`,
            generated: generatedCount,
            skipped: skippedCount
        });
    } catch (err) {
        logger.error({ err }, "Generate salary sheet error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// 2. GET /api/salary: List generated salaries with filters
router.get("/salary", requireRole("admin", "accountant"), async (req, res) => {
    try {
        const { month, year, department, designation, paymentStatus } = req.query;
        // Perform inner join
        const data = await db
            .select({
                salary: staffSalariesTable,
                staff: staffTable
            })
            .from(staffSalariesTable)
            .innerJoin(staffTable, eq(staffSalariesTable.staffId, staffTable.id));
        let filtered = data;
        if (month) {
            const m = parseInt(String(month), 10);
            filtered = filtered.filter(item => item.salary.month === m);
        }
        if (year) {
            const y = parseInt(String(year), 10);
            filtered = filtered.filter(item => item.salary.year === y);
        }
        if (department) {
            filtered = filtered.filter(item => item.staff.department === String(department));
        }
        if (designation) {
            filtered = filtered.filter(item => item.staff.role === String(designation));
        }
        if (paymentStatus) {
            filtered = filtered.filter(item => item.salary.paymentStatus === String(paymentStatus));
        }
        // Return mapped fields
        return res.json(filtered.map(item => ({
            id: item.salary.id,
            staffId: item.staff.id,
            staffIdStr: item.staff.staffId,
            employeeName: item.staff.name,
            designation: item.staff.role,
            department: item.staff.department,
            grossSalary: Number(item.salary.grossSalary),
            basicSalary: Number(item.salary.basicSalary),
            pf: Number(item.salary.pf),
            pt: Number(item.salary.pt),
            leaveDays: Number(item.salary.leaveDays),
            leaveDeduction: Number(item.salary.leaveDeduction),
            totalDeduction: Number(item.salary.totalDeduction),
            netSalary: Number(item.salary.netSalary),
            paymentStatus: item.salary.paymentStatus,
            paymentDate: item.salary.paymentDate ? item.salary.paymentDate.toISOString() : null,
            paidBy: item.salary.paidBy,
            transactionReference: item.salary.transactionReference,
            remarks: item.salary.remarks,
            month: item.salary.month,
            year: item.salary.year,
            createdAt: item.salary.createdAt.toISOString()
        })));
    } catch (err) {
        logger.error({ err }, "Get salaries error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// 3. GET /api/salary/:id: Get single salary details
router.get("/salary/:id", requireRole("admin", "accountant"), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid salary ID" });
        const [item] = await db
            .select({
                salary: staffSalariesTable,
                staff: staffTable
            })
            .from(staffSalariesTable)
            .innerJoin(staffTable, eq(staffSalariesTable.staffId, staffTable.id))
            .where(eq(staffSalariesTable.id, id));
        if (!item) return res.status(404).json({ error: "Salary record not found" });
        return res.json({
            id: item.salary.id,
            staffId: item.staff.id,
            staffIdStr: item.staff.staffId,
            employeeName: item.staff.name,
            designation: item.staff.role,
            department: item.staff.department,
            joiningDate: item.staff.joinDate,
            grossSalary: Number(item.salary.grossSalary),
            basicSalary: Number(item.salary.basicSalary),
            pf: Number(item.salary.pf),
            pt: Number(item.salary.pt),
            leaveDays: Number(item.salary.leaveDays),
            leaveDeduction: Number(item.salary.leaveDeduction),
            totalDeduction: Number(item.salary.totalDeduction),
            netSalary: Number(item.salary.netSalary),
            paymentStatus: item.salary.paymentStatus,
            paymentDate: item.salary.paymentDate ? item.salary.paymentDate.toISOString() : null,
            paidBy: item.salary.paidBy,
            transactionReference: item.salary.transactionReference,
            remarks: item.salary.remarks,
            month: item.salary.month,
            year: item.salary.year
        });
    } catch (err) {
        logger.error({ err }, "Get single salary error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// 4. PUT /api/salary/:id: Update/override leave count and recalculate
router.put("/salary/:id", requireRole("admin", "accountant"), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid salary ID" });
        const { leaveDays } = req.body;
        if (leaveDays == null || Number.isNaN(parseFloat(leaveDays))) {
            return res.status(400).json({ error: "Valid Leave Days count is required" });
        }
        const [salaryRecord] = await db.select().from(staffSalariesTable).where(eq(staffSalariesTable.id, id));
        if (!salaryRecord) return res.status(404).json({ error: "Salary record not found" });
        if (salaryRecord.paymentStatus === "Paid") {
            return res.status(400).json({ error: "Cannot modify leave count on a paid salary record" });
        }
        const calcs = calculateSalaryDetails(salaryRecord.grossSalary, parseFloat(leaveDays));
        await db.update(staffSalariesTable)
            .set({
                leaveDays: calcs.leaveDays,
                leaveDeduction: calcs.leaveDeduction,
                totalDeduction: calcs.totalDeduction,
                netSalary: calcs.netSalary
            })
            .where(eq(staffSalariesTable.id, id));
        return res.json({ success: true, message: "Leave count overridden and salary recalculated" });
    } catch (err) {
        logger.error({ err }, "Update salary leaves error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// 5. POST /api/salary/pay/:salaryId: Pay Salary
router.post("/salary/pay/:salaryId", requireRole("admin", "accountant"), async (req, res) => {
    try {
        const salaryId = parseInt(req.params.salaryId, 10);
        if (Number.isNaN(salaryId)) return res.status(400).json({ error: "Invalid salary ID" });
        const { remarks } = req.body;
        const [salaryRecord] = await db.select().from(staffSalariesTable).where(eq(staffSalariesTable.id, salaryId));
        if (!salaryRecord) return res.status(404).json({ error: "Salary record not found" });
        if (salaryRecord.paymentStatus === "Paid") {
            return res.status(400).json({ error: "Salary is already paid" });
        }
        const [staff] = await db.select().from(staffTable).where(eq(staffTable.id, salaryRecord.staffId));
        if (!staff) return res.status(404).json({ error: "Staff details not found" });
        // Generate Transaction Ref
        const txnRef = `TXN-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
        const payDate = new Date();
        // Update staff_salaries
        await db.update(staffSalariesTable)
            .set({
                paymentStatus: "Paid",
                paymentDate: payDate,
                paidBy: req.user.name || req.user.username,
                transactionReference: txnRef,
                remarks: remarks || null
            })
            .where(eq(staffSalariesTable.id, salaryId));
        // Create Payslip entry
        const payslipNum = `PAY-${salaryRecord.year}${String(salaryRecord.month).padStart(2, '0')}-${salaryId}`;
        const pdfUrl = `/api/payslip/download/${salaryId}`;
        
        await db.insert(payslipsTable).values({
            salaryId: salaryId,
            staffId: staff.id,
            payslipNumber: payslipNum,
            pdfUrl: pdfUrl
        });
        // Create Notification entry
        const payDateStr = payDate.toLocaleDateString("en-IN", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric"
        }).replace(/\//g, "-");
        
        const netSalFormatted = Number(salaryRecord.netSalary).toLocaleString("en-IN");
        const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        const monthName = monthNames[salaryRecord.month - 1];
        await db.insert(salaryNotificationsTable).values({
            staffId: staff.id,
            title: "Salary Credited Successfully",
            message: `Your salary for ${monthName} ${salaryRecord.year} has been processed. Net Salary: ₹${netSalFormatted}. Payment Date: ${payDateStr}.`
        });
        // Modify status of run in salary_months if all salaries are processed
        const pending = await db.select()
            .from(staffSalariesTable)
            .where(
                and(
                    eq(staffSalariesTable.month, salaryRecord.month),
                    eq(staffSalariesTable.year, salaryRecord.year),
                    eq(staffSalariesTable.paymentStatus, "Pending")
                )
            );
        if (pending.length === 0) {
            await db.update(salaryMonthsTable)
                .set({ status: "processed" })
                .where(
                    and(
                        eq(salaryMonthsTable.month, salaryRecord.month),
                        eq(salaryMonthsTable.year, salaryRecord.year)
                    )
                );
        }
        return res.json({
            success: true,
            message: "Salary paid successfully",
            transactionReference: txnRef,
            payslipNumber: payslipNum
        });
    } catch (err) {
        logger.error({ err }, "Pay salary error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// 6. POST /api/payslip/generate/:salaryId: Register payslip metadata
router.post("/payslip/generate/:salaryId", requireRole("admin", "accountant"), async (req, res) => {
    try {
        const salaryId = parseInt(req.params.salaryId, 10);
        if (Number.isNaN(salaryId)) return res.status(400).json({ error: "Invalid salary ID" });
        const [salaryRecord] = await db.select().from(staffSalariesTable).where(eq(staffSalariesTable.id, salaryId));
        if (!salaryRecord) return res.status(404).json({ error: "Salary record not found" });
        // Check if payslip already exists
        const existing = await db.select().from(payslipsTable).where(eq(payslipsTable.salaryId, salaryId));
        if (existing.length > 0) {
            return res.json(existing[0]);
        }
        const payslipNum = `PAY-${salaryRecord.year}${String(salaryRecord.month).padStart(2, '0')}-${salaryId}`;
        const pdfUrl = `/api/payslip/download/${salaryId}`;
        const [payslip] = await db.insert(payslipsTable).values({
            salaryId: salaryId,
            staffId: salaryRecord.staffId,
            payslipNumber: payslipNum,
            pdfUrl: pdfUrl
        }).returning();
        return res.json(payslip);
    } catch (err) {
        logger.error({ err }, "Generate payslip route error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// 7. GET /api/payslip/download/:salaryId: Dynamically Stream Payslip PDF
router.get("/payslip/download/:salaryId", requireAuth, async (req, res) => {
    try {
        const salaryId = parseInt(req.params.salaryId, 10);
        if (Number.isNaN(salaryId)) return res.status(400).json({ error: "Invalid salary ID" });
        const [salaryRecord] = await db.select().from(staffSalariesTable).where(eq(staffSalariesTable.id, salaryId));
        if (!salaryRecord) return res.status(404).json({ error: "Salary record not found" });
        const [staff] = await db.select().from(staffTable).where(eq(staffTable.id, salaryRecord.staffId));
        if (!staff) return res.status(404).json({ error: "Staff member not found" });
        // Security check: Staff can only download their own payslip
        const me = req.user;
        if (me.role !== "admin" && me.role !== "accountant") {
            if (staff.userId !== me.id && staff.email !== me.email) {
                return res.status(403).json({ error: "Forbidden: You cannot access this payslip." });
            }
        }
        // Fetch payslip info
        const [payslip] = await db.select().from(payslipsTable).where(eq(payslipsTable.salaryId, salaryId));
        const payslipNumber = payslip?.payslipNumber ?? `PAY-${salaryRecord.year}${String(salaryRecord.month).padStart(2, '0')}-${salaryId}`;
        const schoolName = await getSchoolName();
        const schoolNameUpper = schoolName.toUpperCase();
        // Initialize PDF Document
        const doc = new PDFDocument({ margin: 50, size: "A4" });
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename=payslip_${payslipNumber}.pdf`);
        doc.pipe(res);
        const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        const monthYearStr = `${monthNames[salaryRecord.month - 1]} ${salaryRecord.year}`;
        // Header Styling
        doc.rect(50, 45, 495, 75).fill("#1A1523");
        doc.fillColor("#A78BFA").fontSize(18).font("Helvetica-Bold").text(schoolNameUpper, 65, 55, { width: 330 });
        doc.fillColor("#94A3B8").fontSize(8).font("Helvetica").text("123, Sector IV, Madhapur, Hyderabad, Telangana", 65, 78);
        doc.text("Email: info@nexusacademy.edu | Contact: +91 40 1234 5678", 65, 92);
        doc.fillColor("#FFFFFF").fontSize(10).font("Helvetica-Bold").text("SALARY PAYSLIP", 420, 58, { align: "right", width: 110 });
        doc.fontSize(8).font("Helvetica").text(monthYearStr, 420, 75, { align: "right", width: 110 });
        doc.text(`Payslip: ${payslipNumber}`, 420, 90, { align: "right", width: 110 });
        // Employee Info Section
        doc.fillColor("#000000").fontSize(10).font("Helvetica-Bold").text("EMPLOYEE DETAILS", 50, 140);
        doc.moveTo(50, 152).lineTo(545, 152).strokeColor("#DDD").stroke();
        doc.fontSize(8).font("Helvetica").fillColor("#4B5563");
        
        doc.text("Employee Name:", 50, 165);
        doc.font("Helvetica-Bold").fillColor("#1F2937").text(staff.name, 140, 165);
        doc.font("Helvetica").fillColor("#4B5563").text("Staff ID:", 50, 180);
        doc.font("Helvetica-Bold").fillColor("#1F2937").text(staff.staffId || "N/A", 140, 180);
        doc.font("Helvetica").fillColor("#4B5563").text("Designation:", 50, 195);
        doc.font("Helvetica-Bold").fillColor("#1F2937").text(staff.role.replace(/_/g, " ").toUpperCase(), 140, 195);
        doc.font("Helvetica").fillColor("#4B5563").text("Department:", 300, 165);
        doc.font("Helvetica-Bold").fillColor("#1F2937").text(staff.department, 390, 165);
        doc.font("Helvetica").fillColor("#4B5563").text("Joining Date:", 300, 180);
        doc.font("Helvetica-Bold").fillColor("#1F2937").text(staff.joinDate || "N/A", 390, 180);
        doc.font("Helvetica").fillColor("#4B5563").text("Payment Date:", 300, 195);
        doc.font("Helvetica-Bold").fillColor("#1F2937").text(salaryRecord.paymentDate ? salaryRecord.paymentDate.toLocaleDateString("en-IN") : "Pending", 390, 195);
        // Earnings and Deductions Tables Side-by-Side
        // Column Headers
        doc.rect(50, 225, 235, 18).fill("#5B21B6");
        doc.rect(310, 225, 235, 18).fill("#9D174D");
        doc.fillColor("#FFFFFF").fontSize(8).font("Helvetica-Bold").text("EARNINGS", 60, 230);
        doc.text("AMOUNT (INR)", 210, 230, { align: "right", width: 65 });
        doc.text("DEDUCTIONS", 320, 230);
        doc.text("AMOUNT (INR)", 470, 230, { align: "right", width: 65 });
        // Values split calculation
        const grossVal = parseFloat(salaryRecord.grossSalary);
        const basicVal = parseFloat(salaryRecord.basicSalary);
        const hraVal = Math.round((grossVal * 0.3) * 100) / 100;
        const otherVal = Math.round((grossVal * 0.2) * 100) / 100;
        const pfVal = parseFloat(salaryRecord.pf);
        const ptVal = parseFloat(salaryRecord.pt);
        const leaveDaysVal = parseFloat(salaryRecord.leaveDays);
        const leaveDedVal = parseFloat(salaryRecord.leaveDeduction);
        const totalDedVal = parseFloat(salaryRecord.totalDeduction);
        const netVal = parseFloat(salaryRecord.netSalary);
        // Grid contents
        doc.fillColor("#1F2937").fontSize(8).font("Helvetica");
        
        // Line 1
        doc.text("Basic Salary", 60, 255);
        doc.text(`₹${basicVal.toFixed(2)}`, 210, 255, { align: "right", width: 65 });
        doc.text("Provident Fund (PF)", 320, 255);
        doc.text(`₹${pfVal.toFixed(2)}`, 470, 255, { align: "right", width: 65 });
        doc.moveTo(50, 270).lineTo(285, 270).strokeColor("#EEE").stroke();
        doc.moveTo(310, 270).lineTo(545, 270).strokeColor("#EEE").stroke();
        // Line 2
        doc.text("HRA (House Rent)", 60, 278);
        doc.text(`₹${hraVal.toFixed(2)}`, 210, 278, { align: "right", width: 65 });
        doc.text("Professional Tax (PT)", 320, 278);
        doc.text(`₹${ptVal.toFixed(2)}`, 470, 278, { align: "right", width: 65 });
        doc.moveTo(50, 293).lineTo(285, 293).strokeColor("#EEE").stroke();
        doc.moveTo(310, 293).lineTo(545, 293).strokeColor("#EEE").stroke();
        // Line 3
        doc.text("Other Allowances", 60, 301);
        doc.text(`₹${otherVal.toFixed(2)}`, 210, 301, { align: "right", width: 65 });
        doc.text(`Leave Deductions (${leaveDaysVal.toFixed(1)} Days)`, 320, 301);
        doc.text(`₹${leaveDedVal.toFixed(2)}`, 470, 301, { align: "right", width: 65 });
        doc.moveTo(50, 316).lineTo(285, 316).strokeColor("#EEE").stroke();
        doc.moveTo(310, 316).lineTo(545, 316).strokeColor("#EEE").stroke();
        // Totals Rows
        doc.rect(50, 330, 235, 18).fill("#F3F4F6");
        doc.rect(310, 330, 235, 18).fill("#F3F4F6");
        doc.fillColor("#1F2937").font("Helvetica-Bold");
        doc.text("Gross Monthly Salary", 60, 335);
        doc.text(`₹${grossVal.toFixed(2)}`, 210, 335, { align: "right", width: 65 });
        doc.text("Total Deductions", 320, 335);
        doc.text(`₹${totalDedVal.toFixed(2)}`, 470, 335, { align: "right", width: 65 });
        // Net Pay Section
        doc.rect(50, 370, 495, 35).fill("#F5F3FF");
        doc.fillColor("#4C1D95").fontSize(11).font("Helvetica-Bold").text("NET TAKE-HOME SALARY", 65, 382);
        doc.fontSize(12).text(`₹${netVal.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 380, 382, { align: "right", width: 150 });
        // Net Salary in Words
        doc.fillColor("#4B5563").fontSize(8).font("Helvetica-Oblique").text(`In Words: ${numberToWords(netVal)}`, 50, 420);
        // Transaction Details
        doc.fillColor("#4B5563").font("Helvetica").text("TRANSACTION DETAILS", 50, 450);
        doc.moveTo(50, 460).lineTo(545, 460).strokeColor("#DDD").stroke();
        
        doc.text("Payment Mode: Bank Account Transfer", 50, 470);
        doc.text(`Transaction Reference: ${salaryRecord.transactionReference || "Pending"}`, 50, 482);
        doc.text(`Paid By Admin: ${salaryRecord.paidBy || "Pending"}`, 300, 470);
        doc.text(`Remarks: ${salaryRecord.remarks || "Regular Monthly Salary Disbursement"}`, 300, 482);
        // Footer / Seal and Signatures
        doc.fontSize(8).fillColor("#9CA3AF");
        doc.text("Note: This is a system-generated payslip and does not require a physical signature.", 50, 530);
        doc.moveTo(50, 600).lineTo(200, 600).strokeColor("#DDD").stroke();
        doc.moveTo(395, 600).lineTo(545, 600).strokeColor("#DDD").stroke();
        doc.fillColor("#4B5563").fontSize(8).font("Helvetica-Bold");
        doc.text("Authorized Signature", 50, 608, { width: 150, align: "center" });
        doc.text("Employee Signature", 395, 608, { width: 150, align: "center" });
        // School Seal mockup
        doc.rect(260, 570, 70, 70).dash(5, { space: 3 }).strokeColor("#A78BFA").stroke();
        doc.fillColor("#A78BFA").fontSize(7).font("Helvetica-Bold").text(schoolNameUpper, 260, 595, { width: 70, align: "center" });
        doc.fontSize(6).text("SEAL", 260, 610, { width: 70, align: "center" });
        doc.end();
    } catch (err) {
        logger.error({ err }, "Payslip PDF generation error");
        if (!res.headersSent) {
            return res.status(500).json({ error: "Internal server error" });
        }
    }
});
// 8. GET /api/staff/my-salaries: Get salary history for staff portal
router.get("/staff/my-salaries", requireAuth, async (req, res) => {
    try {
        const me = req.user;
        
        // Find staff record for user
         // Find staff record for user (try userId first, fallback to email)
        let [staff] = await db.select().from(staffTable).where(
            eq(staffTable.userId, me.id)
        );
         if (!staff && me.email) {
            [staff] = await db.select().from(staffTable).where(
                eq(staffTable.email, me.email)
            );
            // Link the staff record to user for future lookups
            if (staff) {
                await db.update(staffTable).set({ userId: me.id }).where(eq(staffTable.id, staff.id));
            }
        }
        if (!staff) return res.status(404).json({ error: "Staff profile not found" });
        // Retrieve staff salaries
        const history = await db.select()
            .from(staffSalariesTable)
            .where(eq(staffSalariesTable.staffId, staff.id))
            .orderBy(desc(staffSalariesTable.year), desc(staffSalariesTable.month));
        return res.json(history.map(item => ({
            id: item.id,
            month: item.month,
            year: item.year,
            grossSalary: Number(item.grossSalary),
            basicSalary: Number(item.basicSalary),
            pf: Number(item.pf),
            pt: Number(item.pt),
            leaveDays: Number(item.leaveDays),
            leaveDeduction: Number(item.leaveDeduction),
            totalDeduction: Number(item.totalDeduction),
            netSalary: Number(item.netSalary),
            paymentStatus: item.paymentStatus,
            paymentDate: item.paymentDate ? item.paymentDate.toISOString() : null,
            transactionReference: item.transactionReference
        })));
    } catch (err) {
        logger.error({ err }, "Get staff salaries history error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// 9. GET /api/staff/my-payslips: Get payslips for staff portal
router.get("/staff/my-payslips", requireAuth, async (req, res) => {
    try {
        const me = req.user;
        // Find staff record for user
        let [staff] = await db.select().from(staffTable).where(
            eq(staffTable.userId, me.id)
        );
        if (!staff && me.email) {
            [staff] = await db.select().from(staffTable).where(
                eq(staffTable.email, me.email)
            );
            if (staff) {
                await db.update(staffTable).set({ userId: me.id }).where(eq(staffTable.id, staff.id));
            }
        }
        if (!staff) return res.status(404).json({ error: "Staff profile not found" });
        const history = await db.select()
            .from(payslipsTable)
            .where(eq(payslipsTable.staffId, staff.id))
            .orderBy(desc(payslipsTable.generatedAt));
        return res.json(history.map(item => ({
            id: item.id,
            salaryId: item.salaryId,
            payslipNumber: item.payslipNumber,
            pdfUrl: item.pdfUrl,
            generatedAt: item.generatedAt.toISOString()
        })));
    } catch (err) {
        logger.error({ err }, "Get staff payslips error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
export default router;
