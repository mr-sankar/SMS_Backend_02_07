import { pgTable, serial, text, integer, timestamp, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
export const subjectsTable = pgTable("subjects", {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    code: varchar("code", { length: 20 }).notNull(),
    classId: integer("class_id"),
    teacherId: integer("teacher_id"),
    description: text("description"),
    credits: integer("credits"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertSubjectSchema = createInsertSchema(subjectsTable).omit({ id: true, createdAt: true });
