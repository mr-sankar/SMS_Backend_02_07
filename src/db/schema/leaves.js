import { pgTable, serial, text, integer, timestamp, varchar, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
export const leaveRequestsTable = pgTable("leave_requests", {
    id: serial("id").primaryKey(),
    applicantId: integer("applicant_id").notNull(),
    applicantType: varchar("applicant_type", { length: 20 }).notNull(),
    leaveType: varchar("leave_type", { length: 30 }).notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    reason: text("reason").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    approvedById: integer("approved_by_id"),
    remarks: text("remarks"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertLeaveRequestSchema = createInsertSchema(leaveRequestsTable).omit({ id: true, createdAt: true });
