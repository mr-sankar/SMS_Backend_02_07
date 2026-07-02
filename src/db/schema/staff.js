import { pgTable, serial, text, integer, timestamp, varchar, date, numeric, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
export const staffTable = pgTable("staff", {
    id: serial("id").primaryKey(),
    staffId: text("staff_id").unique(),
    name: text("name").notNull(),
    role: varchar("role", { length: 50 }).notNull(),
    department: text("department").notNull(),
    email: text("email").notNull().unique(),
    phone: text("phone"),
    qualification: text("qualification"),
    salary: numeric("salary", { precision: 10, scale: 2 }),
    monthlySalary: numeric("monthly_salary", { precision: 10, scale: 2 }),
    yearsOfExperience: integer("years_of_experience"),
    joinDate: date("join_date").notNull(),
    status: varchar("status", { length: 30 }).notNull().default("active"),
    avatarUrl: text("avatar_url"),
    userId: integer("user_id"),
    documents: jsonb("documents").$type().default([]).notNull(),
    performanceNotes: text("performance_notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertStaffSchema = createInsertSchema(staffTable).omit({ id: true, createdAt: true });
