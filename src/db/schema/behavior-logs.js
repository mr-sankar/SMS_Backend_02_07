import { pgTable, serial, text, integer, timestamp, varchar, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
export const behaviorLogsTable = pgTable("behavior_logs", {
    id: serial("id").primaryKey(),
    studentId: integer("student_id").notNull(),
    classId: integer("class_id"),
    teacherId: integer("teacher_id"),
    type: varchar("type", { length: 20 }).notNull().default("neutral"),
    category: varchar("category", { length: 50 }).notNull(),
    description: text("description").notNull(),
    date: date("date").notNull(),
    points: integer("points").default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertBehaviorLogSchema = createInsertSchema(behaviorLogsTable).omit({ id: true, createdAt: true });
