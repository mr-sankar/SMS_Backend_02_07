import { pgTable, serial, text, integer, timestamp, varchar, customType } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
const bytea = customType({
    dataType() {
        return "bytea";
    },
});
export const announcementsTable = pgTable("announcements", {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    audience: varchar("audience", { length: 30 }).notNull(),
    classId: integer("class_id"),
    priority: varchar("priority", { length: 20 }).notNull().default("normal"),
    authorId: integer("author_id").notNull(),
    publishAt: timestamp("publish_at"),
    expiresAt: timestamp("expires_at"),
    attachmentUrl: text("attachment_url"),
    attachmentName: text("attachment_name"),
    attachmentMimeType: text("attachment_mime_type"),
    attachmentData: bytea("attachment_data"),
    attachmentSize: text("attachment_size"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertAnnouncementSchema = createInsertSchema(announcementsTable).omit({ id: true, createdAt: true });
