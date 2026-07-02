import { pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
export const usersTable = pgTable("users", {
    id: serial("id").primaryKey(),
    username: varchar("username", { length: 100 }).notNull().unique(),
    password: text("password").notNull(),
    role: varchar("role", { length: 50 }).notNull(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    phone: text("phone"),
    parentId: text("parent_id").unique(),
    address: text("address"),
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true });