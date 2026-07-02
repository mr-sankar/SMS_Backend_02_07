import { pgTable, serial, text, integer, timestamp, varchar, boolean, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
export const hostelsTable = pgTable("hostels", {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    type: varchar("type", { length: 20 }).notNull(),
    capacity: integer("capacity").notNull(),
    address: text("address"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const hostelRoomsTable = pgTable("hostel_rooms", {
    id: serial("id").primaryKey(),
    roomNumber: varchar("room_number", { length: 20 }).notNull(),
    block: varchar("block", { length: 20 }).notNull(),
    floor: integer("floor").notNull(),
    capacity: integer("capacity").notNull(),
    occupied: integer("occupied").notNull().default(0),
    type: varchar("type", { length: 20 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("available"),
    facilities: text("facilities"),
    monthlyFee: numeric("monthly_fee"),
    hostelId: integer("hostel_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const hostelApplicationsTable = pgTable("hostel_applications", {
    id: serial("id").primaryKey(),
    studentId: integer("student_id").notNull(),
    preferredBlock: varchar("preferred_block", { length: 20 }).notNull(),
    preferredRoomType: varchar("preferred_room_type", { length: 20 }).notNull(),
    roomId: integer("room_id"),
    bed: varchar("bed", { length: 20 }),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    remarks: text("remarks"),
    appliedAt: timestamp("applied_at").defaultNow().notNull(),
});
export const hostelAttendanceTable = pgTable("hostel_attendance", {
    id: serial("id").primaryKey(),
    studentId: integer("student_id").notNull(),
    date: varchar("date", { length: 20 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("in"),
    recordedAt: timestamp("recorded_at").defaultNow().notNull(),
});
export const hostelMealsTable = pgTable("hostel_meals", {
    id: serial("id").primaryKey(),
    day: varchar("day", { length: 20 }).notNull().unique(),
    breakfast: text("breakfast").notNull().default(""),
    lunch: text("lunch").notNull().default(""),
    dinner: text("dinner").notNull().default(""),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export const hostelNoticesTable = pgTable("hostel_notices", {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    urgent: boolean("urgent").notNull().default(false),
    postedByUserId: integer("posted_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const hostelMaintenanceTable = pgTable("hostel_maintenance", {
    id: serial("id").primaryKey(),
    hostelId: integer("hostel_id").notNull(),
    roomId: integer("room_id").notNull(),
    studentId: integer("student_id").notNull(),
    issueDescription: text("issue_description").notNull(),
    category: varchar("category", { length: 30 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    assignedTo: text("assigned_to"),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const hostelVisitorsTable = pgTable("hostel_visitors", {
    id: serial("id").primaryKey(),
    hostelId: integer("hostel_id").notNull(),
    studentId: integer("student_id").notNull(),
    visitorName: text("visitor_name").notNull(),
    relationship: text("relationship").notNull(),
    purpose: text("purpose").notNull(),
    idType: varchar("id_type", { length: 30 }),
    idNumber: varchar("id_number", { length: 50 }),
    date: varchar("date", { length: 20 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    checkInTime: text("check_in_time"),
    checkOutTime: text("check_out_time"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertHostelAttendanceSchema = createInsertSchema(hostelAttendanceTable).omit({ id: true, recordedAt: true });
export const insertHostelRoomSchema = createInsertSchema(hostelRoomsTable).omit({ id: true, createdAt: true });
export const insertHostelApplicationSchema = createInsertSchema(hostelApplicationsTable).omit({ id: true, appliedAt: true });
export const insertHostelMealSchema = createInsertSchema(hostelMealsTable).omit({ id: true, updatedAt: true });
export const insertHostelNoticeSchema = createInsertSchema(hostelNoticesTable).omit({ id: true, createdAt: true });
export const insertHostelSchema = createInsertSchema(hostelsTable).omit({ id: true, createdAt: true });
export const insertHostelMaintenanceSchema = createInsertSchema(hostelMaintenanceTable).omit({ id: true, createdAt: true });
export const insertHostelVisitorSchema = createInsertSchema(hostelVisitorsTable).omit({ id: true, createdAt: true });

