import { pgTable, serial, text, integer, timestamp, varchar, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
export const inventoryProductsTable = pgTable("inventory_products", {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    category: varchar("category", { length: 30 }).notNull(),
    unit: varchar("unit", { length: 20 }).notNull().default("pcs"),
    currentStock: integer("current_stock").notNull().default(0),
    reorderThreshold: integer("reorder_threshold").notNull().default(10),
    unitPrice: numeric("unit_price", { precision: 10, scale: 2 }),
    description: text("description"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const stockMovementsTable = pgTable("stock_movements", {
    id: serial("id").primaryKey(),
    productId: integer("product_id").notNull(),
    direction: varchar("direction", { length: 10 }).notNull(), // in | out
    quantity: integer("quantity").notNull(),
    reason: varchar("reason", { length: 40 }).notNull().default("manual"), // manual | po_received | distribution | adjustment
    reference: text("reference"), // e.g. PO number, recipient
    notes: text("notes"),
    recordedBy: integer("recorded_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertInventoryProductSchema = createInsertSchema(inventoryProductsTable).omit({ id: true, createdAt: true });
export const insertStockMovementSchema = createInsertSchema(stockMovementsTable).omit({ id: true, createdAt: true });
