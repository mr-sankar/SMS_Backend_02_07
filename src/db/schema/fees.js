import { pgTable, serial, text, integer, timestamp, varchar, date, numeric, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
export const feeStructuresTable = pgTable("fee_structures", {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    classId: integer("class_id").notNull(),
    academicYear: varchar("academic_year", { length: 20 }).notNull(),
    components: jsonb("components").notNull().default([]),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const feeRecordsTable = pgTable("fee_records", {
    id: serial("id").primaryKey(),
    studentId: integer("student_id").notNull(),
    feeStructureId: integer("fee_structure_id"),
    feeType: text("fee_type").notNull(),
    grossAmount: numeric("gross_amount", { precision: 10, scale: 2 }),
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    paidAmount: numeric("paid_amount", { precision: 10, scale: 2 }),
    dueDate: date("due_date").notNull(),
    paidDate: date("paid_date"),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    paymentMethod: varchar("payment_method", { length: 30 }),
    receiptNumber: varchar("receipt_number", { length: 50 }),
    academicYear: varchar("academic_year", { length: 20 }).notNull(),
    concession: varchar("concession", { length: 20 }).default("0"),
    concessionType: varchar("concession_type", { length: 50 }),
    concessionReason: text("concession_reason"),
    installmentLabel: varchar("installment_label", { length: 80 }),
    termType: varchar("term_type", { length: 50 }).default("Annual"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const feePaymentsTable = pgTable("fee_payments", {
    id: serial("id").primaryKey(),
    feeRecordId: integer("fee_record_id").notNull(),
    studentId: integer("student_id").notNull(),
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    paymentMethod: varchar("payment_method", { length: 30 }).notNull(),
    paymentMode: varchar("payment_mode", { length: 20 }).notNull().default("offline"),
    receiptNumber: varchar("receipt_number", { length: 50 }).notNull(),
    transactionReference: varchar("transaction_reference", { length: 100 }),
    notes: text("notes"),
    paidAt: timestamp("paid_at").defaultNow().notNull(),
    collectedBy: integer("collected_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertFeeStructureSchema = createInsertSchema(feeStructuresTable).omit({ id: true, createdAt: true });
export const insertFeeRecordSchema = createInsertSchema(feeRecordsTable).omit({ id: true, createdAt: true });
export const insertFeePaymentSchema = createInsertSchema(feePaymentsTable).omit({ id: true, createdAt: true });
