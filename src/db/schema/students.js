import { pgTable, serial, text, integer, timestamp, varchar, date, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

// ==================== STUDENTS TABLE (Unchanged + minor improvements) ====================
export const studentsTable = pgTable("students", {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    rollNumber: varchar("roll_number", { length: 50 }).notNull().unique(),
    classId: integer("class_id"),
    lastClassId: integer("last_class_id"),
    gender: varchar("gender", { length: 20 }).notNull(),
    dateOfBirth: date("date_of_birth"),
    phone: text("phone"),
    email: text("email"),
    parentName: text("parent_name"),
    parentPhone: text("parent_phone"),
    address: text("address"),
    academicYear: varchar("academic_year", { length: 20 }),
    status: varchar("status", { length: 30 }).notNull().default("active"),
    admissionDate: date("admission_date").notNull(),
    avatarUrl: text("avatar_url"),
    userId: integer("user_id"),
    documents: jsonb("documents").default([]).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ==================== NEW: STUDENT PROMOTIONS TABLE ====================
export const studentPromotionsTable = pgTable("student_promotions", {
    id: serial("id").primaryKey(),
    studentId: integer("student_id").notNull().references(() => studentsTable.id, { onDelete: "cascade" }),
    fromClassId: integer("from_class_id").notNull().references(() => classesTable.id),
    toClassId: integer("to_class_id").notNull().references(() => classesTable.id),
    academicYear: varchar("academic_year", { length: 20 }).notNull(), // e.g., "2025-2026"
    promotedBy: integer("promoted_by").notNull().references(() => usersTable.id), // Admin/Clerk who promoted
    promotedAt: timestamp("promoted_at").defaultNow().notNull(),
    remarks: text("remarks"), // Optional remarks
});

// ==================== SCHEMAS FOR INSERT/VALIDATION ====================
export const insertStudentSchema = createInsertSchema(studentsTable).omit({ 
    id: true, 
    createdAt: true 
});

export const insertStudentPromotionSchema = createInsertSchema(studentPromotionsTable).omit({ 
    id: true, 
    promotedAt: true 
});

// Optional: Update schema if needed
export const updateStudentSchema = insertStudentSchema.partial();

export default {
    studentsTable,
    studentPromotionsTable,
    insertStudentSchema,
    insertStudentPromotionSchema,
    updateStudentSchema,
}