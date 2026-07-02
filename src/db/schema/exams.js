import { pgTable, serial, text, integer, timestamp, varchar, date, numeric, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
export const examsTable = pgTable("exams", {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    type: varchar("type", { length: 30 }).notNull(),
    classId: integer("class_id").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    maxMarks: integer("max_marks"),
    passingMarks: integer("passing_marks"),
    status: varchar("status", { length: 30 }).notNull().default("upcoming"),
    startTime: text("start_time"),
    endTime: text("end_time"),
    room: text("room"),
    isSupply: boolean("is_supply").default(false),
    originalExamId: integer("original_exam_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const examResultsTable = pgTable("exam_results", {
    id: serial("id").primaryKey(),
    examId: integer("exam_id").notNull(),
    studentId: integer("student_id").notNull(),
    subjectId: integer("subject_id").notNull(),
    marksObtained: numeric("marks_obtained", { precision: 6, scale: 2 }).notNull(),
    maxMarks: numeric("max_marks", { precision: 6, scale: 2 }).notNull(),
    grade: varchar("grade", { length: 5 }).notNull().default(""),
    gpa: numeric("gpa", { precision: 4, scale: 2 }),
    remarks: text("remarks"),
    isSupplementary: boolean("is_supplementary").default(false),
    originalMarks: numeric("original_marks"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertExamSchema = createInsertSchema(examsTable).omit({ id: true, createdAt: true });
export const insertExamResultSchema = createInsertSchema(examResultsTable).omit({ id: true, createdAt: true });
