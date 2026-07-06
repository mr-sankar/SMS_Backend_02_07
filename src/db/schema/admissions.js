import { pgTable, serial, text, timestamp, varchar, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
export const admissionsTable = pgTable("admissions", {
    id: serial("id").primaryKey(),
    applicantName: text("applicant_name").notNull(),
    dateOfBirth: text("date_of_birth").notNull(),
    gender: varchar("gender", { length: 20 }).notNull(),
    applyingForClass: varchar("applying_for_class", { length: 30 }).notNull(),
    previousSchool: text("previous_school"),
    parentName: text("parent_name").notNull(),
    parentEmail: text("parent_email").notNull(),
    parentPhone: text("parent_phone").notNull(),
    address: text("address"),
    documents: text("documents"),
    status: varchar("status", { length: 30 }).notNull().default("pending"),
    remarks: text("remarks"),
    testStatus: varchar("test_status", { length: 30 }).default("not_assigned"),
    testDate: text("test_date"),
    testScore: text("test_score"),
    interviewScore: text("interview_score"),
    meritListIncluded: text("merit_list_included"), // "yes", "no"
    meritRank: text("merit_rank"),
    academicYear: varchar("academic_year", { length: 20 }),
    appliedAt: timestamp("applied_at").defaultNow().notNull(),
    reviewedAt: timestamp("reviewed_at"),
});
export const insertAdmissionSchema = createInsertSchema(admissionsTable).omit({ id: true, appliedAt: true });

export const admissionInquiriesTable = pgTable("admission_inquiries", {
    id: serial("id").primaryKey(),
    applicantName: text("applicant_name").notNull(),
    applyingForClass: varchar("applying_for_class", { length: 30 }).notNull(),
    parentName: text("parent_name").notNull(),
    parentEmail: text("parent_email").notNull(),
    parentPhone: text("parent_phone").notNull(),
    message: text("message"),
    status: varchar("status", { length: 20 }).notNull().default("new"),
    source: varchar("source", { length: 50 }).notNull().default("Website"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const admissionFormPurchasesTable = pgTable("admission_form_purchases", {
    id: serial("id").primaryKey(),
    applicantName: text("applicant_name").notNull(),
    applyingForClass: varchar("applying_for_class", { length: 30 }).notNull(),
    parentName: text("parent_name").notNull(),
    parentEmail: text("parent_email").notNull(),
    parentPhone: text("parent_phone").notNull(),
    mode: varchar("mode", { length: 20 }).notNull(), // 'online' or 'offline'
    paymentMethod: varchar("payment_method", { length: 20 }).notNull(), // 'cash', 'upi', 'card'
    paymentStatus: varchar("payment_status", { length: 20 }).notNull().default("pending"),
    amount: varchar("amount", { length: 20 }).notNull().default("500"),
    transactionId: text("transaction_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAdmissionInquirySchema = createInsertSchema(admissionInquiriesTable).omit({ id: true, createdAt: true });
export const insertAdmissionFormPurchaseSchema = createInsertSchema(admissionFormPurchasesTable).omit({ id: true, createdAt: true });
