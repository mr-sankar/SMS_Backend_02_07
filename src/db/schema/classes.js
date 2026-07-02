import { pgTable, serial, text, integer, timestamp, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
export const classesTable = pgTable("classes", {
    id: serial("id").primaryKey(),
    grade: varchar("grade", { length: 20 }).notNull(),
    section: varchar("section", { length: 10 }).notNull(),
    teacherId: integer("teacher_id"),
    academicYear: varchar("academic_year", { length: 20 }).notNull(),
    room: text("room"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertClassSchema = createInsertSchema(classesTable).omit({ id: true, createdAt: true });
