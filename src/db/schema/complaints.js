import { pgTable, serial, text, integer, timestamp, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
export const complaintsTable = pgTable("complaints", {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    category: varchar("category", { length: 30 }).notNull(),
    submittedById: integer("submitted_by_id").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    priority: varchar("priority", { length: 20 }).notNull().default("medium"),
    assignedTo: text("assigned_to"),
    resolution: text("resolution"),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertComplaintSchema = createInsertSchema(complaintsTable).omit({ id: true, createdAt: true });
