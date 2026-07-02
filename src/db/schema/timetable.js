import { pgTable, serial, integer, timestamp, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
export const timetableSlotsTable = pgTable("timetable_slots", {
    id: serial("id").primaryKey(),
    classId: integer("class_id").notNull(),
    subjectId: integer("subject_id").notNull(),
    staffId: integer("staff_id").notNull(),
    dayOfWeek: varchar("day_of_week", { length: 10 }).notNull(),
    startTime: varchar("start_time", { length: 10 }).notNull(),
    endTime: varchar("end_time", { length: 10 }).notNull(),
    room: varchar("room", { length: 50 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertTimetableSlotSchema = createInsertSchema(timetableSlotsTable).omit({ id: true, createdAt: true });
