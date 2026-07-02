import { pgTable, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const schoolSettingsTable = pgTable("school_settings", {
    id: integer("id").primaryKey().default(1),
    name: text("name").notNull(),
    logoUrl: text("logo_url"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertSchoolSettingsSchema = createInsertSchema(schoolSettingsTable).omit({
    updatedAt: true,
});
