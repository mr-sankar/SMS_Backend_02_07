import { pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
export const visitorLogTable = pgTable("visitor_log", {
    id: serial("id").primaryKey(),
    visitorName: text("visitor_name").notNull(),
    visitorPhone: text("visitor_phone"),
    purpose: text("purpose").notNull(),
    personToMeet: text("person_to_meet").notNull(),
    department: text("department"),
    idType: varchar("id_type", { length: 30 }),
    idNumber: varchar("id_number", { length: 50 }),
    badge: varchar("badge", { length: 20 }),
    status: varchar("status", { length: 20 }).notNull().default("inside"),
    checkIn: timestamp("check_in").defaultNow().notNull(),
    checkOut: timestamp("check_out"),
    remarks: text("remarks"),
});
export const insertVisitorSchema = createInsertSchema(visitorLogTable).omit({ id: true, checkIn: true });

export const phoneCallLogsTable = pgTable("phone_call_logs", {
    id: serial("id").primaryKey(),
    contactName: text("contact_name").notNull(),
    phoneNumber: text("phone_number").notNull(),
    callType: varchar("call_type", { length: 20 }).notNull(), // 'incoming' or 'outgoing'
    purpose: text("purpose"),
    followUpDate: text("follow_up_date"),
    remarks: text("remarks"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const postalCourierLogsTable = pgTable("postal_courier_logs", {
    id: serial("id").primaryKey(),
    type: varchar("type", { length: 20 }).notNull(), // 'incoming' or 'outgoing'
    referenceNumber: text("reference_number"),
    senderName: text("sender_name").notNull(),
    receiverName: text("receiver_name").notNull(),
    courierService: text("courier_service"),
    imageUrl: text("image_url"),
    dispatchStatus: varchar("dispatch_status", { length: 20 }).notNull().default("pending"), // 'pending', 'dispatched', 'delivered'
    date: text("date"),
    remarks: text("remarks"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPhoneCallLogSchema = createInsertSchema(phoneCallLogsTable).omit({ id: true, createdAt: true });
export const insertPostalCourierLogSchema = createInsertSchema(postalCourierLogsTable).omit({ id: true, createdAt: true });
