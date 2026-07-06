import { pgTable, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const schoolSettingsTable = pgTable("school_settings", {
    id: integer("id").primaryKey().default(1),
    name: text("name").notNull(),
    logoUrl: text("logo_url"),
    schoolStartTime: text("school_start_time").default("10:00").notNull(),
    schoolEndTime: text("school_end_time").default("17:30").notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertSchoolSettingsSchema = createInsertSchema(schoolSettingsTable).omit({
    updatedAt: true,
});
