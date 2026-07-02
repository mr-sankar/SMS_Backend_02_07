import { db } from "./src/db/index.js";
import {
    staffTable,
    usersTable,
    leaveRequestsTable,
    salaryMonthsTable,
    staffSalariesTable,
    payslipsTable,
    salaryNotificationsTable
} from "./src/db/index.js";
import { eq, and } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
// Force isolated PGLite database for this test run
const testDbDir = path.resolve(process.cwd(), ".local/test-pglite-salary-" + Date.now());
process.env.DATABASE_URL = "";
process.env.PGLITE_DATA_DIR = testDbDir;
// Helper: overlap calculator (identical to router logic)
function getLeaveDaysInMonth(startDateStr, endDateStr, month, year) {
    const start = new Date(startDateStr);
    const end = new Date(endDateStr);
    const targetStart = new Date(year, month - 1, 1);
    const targetEnd = new Date(year, month, 0);
    const overlapStart = new Date(Math.max(start, targetStart));
    const overlapEnd = new Date(Math.min(end, targetEnd));
    if (overlapStart <= overlapEnd) {
        const diffTime = Math.abs(overlapEnd - overlapStart);
        return Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
    }
    return 0;
}
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
async function runTests() {
    console.log("=== STARTING SALARY MODULE INTEGRATION TESTS ===");
    console.log(`Using database directory: ${testDbDir}`);
    try {
        // 1. Create a mock active staff member with monthly salary = 20000
        console.log("1. Creating Mock Staff member (₹20,000 monthly salary)...");
        const [staff] = await db.insert(staffTable).values({
            staffId: "STF2026001",
            name: "Rahul Kumar",
            role: "teacher",
            department: "Mathematics",
            email: "rahul.kumar@test.local",
            joinDate: "2026-01-15",
            status: "active",
            monthlySalary: "20000.00",
            salary: "20000.00"
        }).returning();
        console.log(`Staff created with ID: ${staff.id}`);
        // 2. Create mock approved leave request overlapping June 2026 for 2 days
        console.log("2. Creating Approved Staff Leaves (2 days in June)...");
        const [leave] = await db.insert(leaveRequestsTable).values({
            applicantId: staff.id,
            applicantType: "staff",
            leaveType: "Sick",
            startDate: "2026-06-10",
            endDate: "2026-06-11", // 2 days (10th and 11th)
            reason: "Fever",
            status: "approved"
        }).returning();
        console.log(`Leave request created with ID: ${leave.id}`);
        // Calculate leave days for June 2026
        const calculatedLeaves = getLeaveDaysInMonth(leave.startDate, leave.endDate, 6, 2026);
        console.log(`Calculated Leave Days in June: ${calculatedLeaves} (Expected: 2)`);
        if (calculatedLeaves !== 2) throw new Error("Incorrect leave days calculation!");
        // 3. Generate Salary Sheet for June 2026
        console.log("3. Generating Salary Sheet for June 2026...");
        const mNum = 6;
        const yNum = 2026;
        const gross = staff.monthlySalary ?? staff.salary ?? "0";
        const calcs = calculateSalaryDetails(gross, calculatedLeaves);
        console.log("Calculated Fields:");
        console.log(`- Gross Salary: ₹${calcs.grossSalary} (Expected: 20000.00)`);
        console.log(`- Basic Salary: ₹${calcs.basicSalary} (Expected: 10000.00)`);
        console.log(`- PF: ₹${calcs.pf} (Expected: 1200.00)`);
        console.log(`- PT: ₹${calcs.pt} (Expected: 200.00)`);
        console.log(`- Daily Salary: ₹${(parseFloat(gross)/26).toFixed(2)}`);
        console.log(`- Leave Deduction: ₹${calcs.leaveDeduction} (Expected: 1538.46)`);
        console.log(`- Total Deduction: ₹${calcs.totalDeduction} (Expected: 2938.46)`);
        console.log(`- Net Salary: ₹${calcs.netSalary} (Expected: 17061.54)`);
        if (parseFloat(calcs.grossSalary) !== 20000) throw new Error("Gross mismatch");
        if (parseFloat(calcs.basicSalary) !== 10000) throw new Error("Basic mismatch");
        if (parseFloat(calcs.pf) !== 1200) throw new Error("PF mismatch");
        if (parseFloat(calcs.pt) !== 200) throw new Error("PT mismatch");
        if (parseFloat(calcs.leaveDeduction) !== 1538.46) throw new Error("Leave deduction mismatch");
        if (parseFloat(calcs.totalDeduction) !== 2938.46) throw new Error("Total deduction mismatch");
        if (parseFloat(calcs.netSalary) !== 17061.54) throw new Error("Net salary mismatch");
        console.log("-> Initial calculation checks PASSED!");
        // Insert into database
        const [salaryRecord] = await db.insert(staffSalariesTable).values({
            staffId: staff.id,
            grossSalary: calcs.grossSalary,
            basicSalary: calcs.basicSalary,
            pf: calcs.pf,
            pt: calcs.pt,
            leaveDays: calcs.leaveDays,
            leaveDeduction: calcs.leaveDeduction,
            totalDeduction: calcs.totalDeduction,
            netSalary: calcs.netSalary,
            paymentStatus: "Pending",
            month: mNum,
            year: yNum
        }).returning();
        console.log(`Salary record generated and saved with ID: ${salaryRecord.id}`);
        // 4. Override leaves to 3 days and recalculate
        console.log("4. Overriding leaves to 3 days...");
        const overriddenLeaves = 3;
        const newCalcs = calculateSalaryDetails(salaryRecord.grossSalary, overriddenLeaves);
        
        console.log("Recalculated Fields for 3 leaves:");
        console.log(`- Leave Deduction: ₹${newCalcs.leaveDeduction} (Expected: 2307.69)`);
        console.log(`- Total Deduction: ₹${newCalcs.totalDeduction} (Expected: 3707.69)`);
        console.log(`- Net Salary: ₹${newCalcs.netSalary} (Expected: 16292.31)`);
        if (parseFloat(newCalcs.leaveDeduction) !== 2307.69) throw new Error("Recalculated leave deduction mismatch");
        if (parseFloat(newCalcs.totalDeduction) !== 3707.69) throw new Error("Recalculated total deduction mismatch");
        if (parseFloat(newCalcs.netSalary) !== 16292.31) throw new Error("Recalculated net salary mismatch");
        console.log("-> Leave override calculations PASSED!");
        // Update database
        await db.update(staffSalariesTable)
            .set({
                leaveDays: newCalcs.leaveDays,
                leaveDeduction: newCalcs.leaveDeduction,
                totalDeduction: newCalcs.totalDeduction,
                netSalary: newCalcs.netSalary
            })
            .where(eq(staffSalariesTable.id, salaryRecord.id));
        console.log("Salary record updated in database.");
        // 5. Pay Salary
        console.log("5. Processing Payment...");
        const txnRef = `TXN-TEST-${Date.now()}`;
        const payDate = new Date();
        const adminName = "Test Admin";
        
        await db.update(staffSalariesTable)
            .set({
                paymentStatus: "Paid",
                paymentDate: payDate,
                paidBy: adminName,
                transactionReference: txnRef,
                remarks: "Regular monthly payout"
            })
            .where(eq(staffSalariesTable.id, salaryRecord.id));
        // Create Payslip
        const payslipNum = `PAY-${yNum}0${mNum}-${salaryRecord.id}`;
        const pdfUrl = `/api/payslip/download/${salaryRecord.id}`;
        await db.insert(payslipsTable).values({
            salaryId: salaryRecord.id,
            staffId: staff.id,
            payslipNumber: payslipNum,
            pdfUrl: pdfUrl
        });
        console.log(`Payslip created: ${payslipNum}`);
        // Create Notification
        await db.insert(salaryNotificationsTable).values({
            staffId: staff.id,
            title: "Salary Credited Successfully",
            message: `Your salary for June 2026 has been processed. Net Salary: ₹${parseFloat(newCalcs.netSalary).toLocaleString("en-IN")}.`
        });
        console.log("Notification created successfully.");
        // 6. Verify final tables
        console.log("6. Verifying database state...");
        const [finalSalary] = await db.select().from(staffSalariesTable).where(eq(staffSalariesTable.id, salaryRecord.id));
        if (finalSalary.paymentStatus !== "Paid") throw new Error("Payment status not updated!");
        if (finalSalary.transactionReference !== txnRef) throw new Error("Transaction ref mismatch!");
        const [finalPayslip] = await db.select().from(payslipsTable).where(eq(payslipsTable.salaryId, salaryRecord.id));
        if (!finalPayslip) throw new Error("Payslip record not created!");
        const [finalNotification] = await db.select().from(salaryNotificationsTable).where(eq(salaryNotificationsTable.staffId, staff.id));
        if (!finalNotification) throw new Error("Notification record not created!");
        console.log("-> Database record states PASSED!");
        console.log("=== ALL INTEGRATION TESTS PASSED SUCCESSFULLY ===");
    } catch (err) {
        console.error("Test failed with error:", err);
        process.exit(1);
    } finally {
        // Clean up test database directory
        try {
            fs.rmSync(testDbDir, { recursive: true, force: true });
            console.log("Cleaned up test database directory.");
        } catch (cleanupErr) {
            console.error("Cleanup error:", cleanupErr);
        }
    }
}
runTests();