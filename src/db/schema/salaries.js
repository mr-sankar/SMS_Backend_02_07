import { pgTable, serial, text, integer, timestamp, varchar, numeric, boolean } from "drizzle-orm/pg-core";
export const salaryMonthsTable = pgTable("salary_months", {
    id: serial("id").primaryKey(),
    month: integer("month").notNull(),
    year: integer("year").notNull(),
    status: varchar("status", { length: 50 }).notNull().default("generated"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const staffSalariesTable = pgTable("staff_salaries", {
    id: serial("id").primaryKey(),
    staffId: integer("staff_id").notNull(),
    grossSalary: numeric("gross_salary", { precision: 10, scale: 2 }).notNull(),
    basicSalary: numeric("basic_salary", { precision: 10, scale: 2 }).notNull(),
    pf: numeric("pf", { precision: 10, scale: 2 }).notNull(),
    pt: numeric("pt", { precision: 10, scale: 2 }).notNull(),
    leaveDays: numeric("leave_days", { precision: 5, scale: 2 }).notNull().default("0.00"),
    leaveDeduction: numeric("leave_deduction", { precision: 10, scale: 2 }).notNull(),
    totalDeduction: numeric("total_deduction", { precision: 10, scale: 2 }).notNull(),
    netSalary: numeric("net_salary", { precision: 10, scale: 2 }).notNull(),
    paymentStatus: varchar("payment_status", { length: 50 }).notNull().default("Pending"),
    paymentDate: timestamp("payment_date"),
    paidBy: text("paid_by"),
    transactionReference: text("transaction_reference"),
    remarks: text("remarks"),
    month: integer("month").notNull(),
    year: integer("year").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const payslipsTable = pgTable("payslips", {
    id: serial("id").primaryKey(),
    salaryId: integer("salary_id").notNull(),
    staffId: integer("staff_id").notNull(),
    payslipNumber: varchar("payslip_number", { length: 100 }).notNull().unique(),
    pdfUrl: text("pdf_url"),
    generatedAt: timestamp("generated_at").defaultNow().notNull(),
});
export const salaryNotificationsTable = pgTable("salary_notifications", {
    id: serial("id").primaryKey(),
    staffId: integer("staff_id").notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    isRead: boolean("is_read").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
