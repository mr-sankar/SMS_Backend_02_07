// vendor.js - schema
import { pgTable, serial, text, integer, timestamp, varchar, numeric, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const vendorsTable = pgTable("vendors", {
    id: serial("id").primaryKey(),
    vendorId: varchar("vendor_id", { length: 50 }).unique(), // Add this field
    name: text("name").notNull(),
    contactPerson: text("contact_person").notNull(),
    email: text("email").notNull(),
    phone: text("phone").notNull(),
    gstNumber: text("gst_number"),
    address: text("address"),
    category: text("category"),
    status: varchar("status", { length: 30 }).notNull().default("pending_verification"),
    rating: numeric("rating", { precision: 3, scale: 1 }),
    userId: integer("user_id"),
    bankAccount: text("bank_account"),
    documents: jsonb("documents").$type().default([]),
    contracts: jsonb("contracts").$type().default([]),
    renewalStatus: varchar("renewal_status", { length: 50 }).default("active"),
    renewalDate: text("renewal_date"),
    communicationLog: jsonb("communication_log").$type().default([]),
    registeredAt: timestamp("registered_at").defaultNow().notNull(),
});


export const purchaseOrdersTable = pgTable("purchase_orders", {
    id: serial("id").primaryKey(),
    poNumber: varchar("po_number", { length: 30 }).notNull().unique(),
    vendorId: integer("vendor_id").notNull(),
    items: jsonb("items").notNull().default([]),
    totalAmount: numeric("total_amount", { precision: 12, scale: 2 }).notNull(),
    status: varchar("status", { length: 30 }).notNull().default("draft"),
    sourceRole: varchar("source_role", { length: 50 }).notNull().default("admin"),
    createdBy: integer("created_by"),
    adminAcceptedAt: timestamp("admin_accepted_at"),
    adminAcceptedBy: integer("admin_accepted_by"),
    vendorConfirmedAt: timestamp("vendor_confirmed_at"),
    vendorConfirmedBy: integer("vendor_confirmed_by"),
    deliveryDate: text("delivery_date"),
    notes: text("notes"),
    invoiceUrl: text("invoice_url"),
    invoiceNumber: text("invoice_number"),
    paidAt: timestamp("paid_at"),
    paymentReference: text("payment_reference"),
    amountPaid: numeric("amount_paid", { precision: 12, scale: 2 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertVendorSchema = createInsertSchema(vendorsTable).omit({ id: true, registeredAt: true });

export const insertPurchaseOrderSchema = createInsertSchema(purchaseOrdersTable).omit({ id: true, createdAt: true });