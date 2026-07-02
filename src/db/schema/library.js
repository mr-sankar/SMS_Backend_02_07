// ======================== SCHEME / SCHEMA FILE (drizzle schema) ========================
// File: src/db/schema.ts  (or wherever your library tables are defined)
import { pgTable, serial, text, integer, timestamp, varchar, date, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const libraryBooksTable = pgTable("library_books", {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    author: text("author").notNull(),
    isbn: varchar("isbn", { length: 20 }),
    category: varchar("category", { length: 50 }).notNull(),
    totalCopies: integer("total_copies").notNull().default(1),
    availableCopies: integer("available_copies").notNull().default(1),
    publisher: text("publisher"),
    publishYear: integer("publish_year"),
    shelfLocation: varchar("shelf_location", { length: 30 }),
    status: varchar("status", { length: 20 }).notNull().default("available"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const libraryIssuancesTable = pgTable("library_issuances", {
    id: serial("id").primaryKey(),
    bookId: integer("book_id").notNull(),
    borrowerId: integer("borrower_id").notNull(), // student id or staff id
    borrowerType: varchar("borrower_type", { length: 20 }).notNull(), // "student" | "staff"
    issueDate: date("issue_date").notNull(),
    dueDate: date("due_date").notNull(),
    returnDate: date("return_date"),
    fine: integer("fine").default(0), // stored final fine (on return)
    status: varchar("status", { length: 20 }).notNull().default("issued"), // issued | returned | overdue
    issuedById: integer("issued_by_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const libraryBookRequestsTable = pgTable("library_book_requests", {
    id: serial("id").primaryKey(),
    bookId: integer("book_id").notNull(),
    studentId: integer("student_id").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    requestedAt: timestamp("requested_at").defaultNow().notNull(),
    handledAt: timestamp("handled_at"),
    handledById: integer("handled_by_id"),
    issuanceId: integer("issuance_id"),
});

// Optional: Fine history for transparency
export const libraryFineHistoryTable = pgTable("library_fine_history", {
    id: serial("id").primaryKey(),
    issuanceId: integer("issuance_id").notNull(),
    amount: integer("amount").notNull(),
    calculatedAt: timestamp("calculated_at").defaultNow().notNull(),
    notes: text("notes"),
});

export const insertLibraryBookSchema = createInsertSchema(libraryBooksTable).omit({ id: true, createdAt: true });
export const insertLibraryIssuanceSchema = createInsertSchema(libraryIssuancesTable).omit({ id: true, createdAt: true });
export const insertLibraryBookRequestSchema = createInsertSchema(libraryBookRequestsTable).omit({ id: true, requestedAt: true });