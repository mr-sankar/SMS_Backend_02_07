import { pgTable, serial, text, integer, timestamp, varchar, uniqueIndex, customType } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
const bytea = customType({
    dataType() {
        return "bytea";
    },
});
export const studyMaterialsTable = pgTable("study_materials", {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description"),
    type: varchar("type", { length: 20 }).notNull(),
    fileUrl: text("file_url"),
    fileName: text("file_name"),
    mimeType: text("mime_type"),
    fileData: bytea("file_data"),
    fileSize: text("file_size"),
    subjectId: integer("subject_id").notNull(),
    classId: integer("class_id").notNull(),
    uploadedById: integer("uploaded_by_id").notNull(),
    downloadCount: integer("download_count").notNull().default(0),
    viewCount: integer("view_count").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const assignmentsTable = pgTable("assignments", {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description"),
    subjectId: integer("subject_id").notNull(),
    classId: integer("class_id").notNull(),
    dueDate: text("due_date").notNull(),
    maxMarks: integer("max_marks").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("draft"),
    attachmentUrl: text("attachment_url"),
    attachmentName: text("attachment_name"),
    attachmentMimeType: text("attachment_mime_type"),
    attachmentData: bytea("attachment_data"),
    attachmentSize: text("attachment_size"),
    createdById: integer("created_by_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const lessonPlansTable = pgTable("lesson_plans", {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    objectives: text("objectives"),
    content: text("content"),
    fileName: text("file_name"),
    mimeType: text("mime_type"),
    fileData: bytea("file_data"),
    fileSize: text("file_size"),
    subjectId: integer("subject_id").notNull(),
    classId: integer("class_id").notNull(),
    teacherId: integer("teacher_id").notNull(),
    weekDate: text("week_date").notNull(),
    duration: integer("duration"),
    lessonOrder: integer("lesson_order"),
    status: varchar("status", { length: 20 }).notNull().default("draft"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const assignmentSubmissionsTable = pgTable("assignment_submissions", {
    id: serial("id").primaryKey(),
    assignmentId: integer("assignment_id").notNull().references(() => assignmentsTable.id, { onDelete: "cascade" }),
    studentId: integer("student_id").notNull(),
    notes: text("notes"),
    attachmentUrl: text("attachment_url"),
    attachmentName: text("attachment_name"),
    attachmentMimeType: text("attachment_mime_type"),
    attachmentData: bytea("attachment_data"),
    attachmentSize: text("attachment_size"),
    status: varchar("status", { length: 20 }).notNull().default("submitted"),
    submittedAt: timestamp("submitted_at").defaultNow().notNull(),
}, (t) => ({
    uniqAssignStudent: uniqueIndex("assign_subm_uniq").on(t.assignmentId, t.studentId),
}));
export const insertStudyMaterialSchema = createInsertSchema(studyMaterialsTable).omit({ id: true, createdAt: true });
export const insertAssignmentSchema = createInsertSchema(assignmentsTable).omit({ id: true, createdAt: true });
export const insertLessonPlanSchema = createInsertSchema(lessonPlansTable).omit({ id: true, createdAt: true });
