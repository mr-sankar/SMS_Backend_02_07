import { pgTable, serial, text, integer, timestamp, varchar, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
export const vehiclesTable = pgTable("vehicles", {
    id: serial("id").primaryKey(),
    vehicleNumber: varchar("vehicle_number", { length: 30 }).notNull().unique(),
    type: varchar("type", { length: 20 }).notNull(),
    capacity: integer("capacity").notNull(),
    driverId: integer("driver_id"),
    model: text("model"),
    insuranceExpiry: text("insurance_expiry"),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const transportRoutesTable = pgTable("transport_routes", {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    startPoint: text("start_point").notNull(),
    endPoint: text("end_point").notNull(),
    vehicleId: integer("vehicle_id"),
    stops: text("stops"),
    morningTime: text("morning_time"),
    eveningTime: text("evening_time"),
    distance: numeric("distance", { precision: 6, scale: 2 }),
    fare: numeric("fare", { precision: 10, scale: 2 }),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const studentTransportAssignmentsTable = pgTable("student_transport_assignments", {
    id: serial("id").primaryKey(),
    studentId: integer("student_id").notNull(),
    routeId: integer("route_id").notNull(),
    pickupStop: text("pickup_stop"),
    dropStop: text("drop_stop"),
    feeStatus: varchar("fee_status", { length: 20 }).notNull().default("pending"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertVehicleSchema = createInsertSchema(vehiclesTable).omit({ id: true, createdAt: true });
export const insertTransportRouteSchema = createInsertSchema(transportRoutesTable).omit({ id: true, createdAt: true });
export const insertStudentTransportAssignmentSchema = createInsertSchema(studentTransportAssignmentsTable).omit({ id: true, createdAt: true });

export const transportLogsTable = pgTable("transport_logs", {
    id: serial("id").primaryKey(),
    studentId: integer("student_id").notNull(),
    routeId: integer("route_id").notNull(),
    action: varchar("action", { length: 20 }).notNull(), // 'boarded' or 'deboarded'
    timestamp: timestamp("timestamp").defaultNow().notNull(),
    location: text("location"),
});
export const insertTransportLogSchema = createInsertSchema(transportLogsTable).omit({ id: true, timestamp: true });

// Add this in transport.js (schema)
export const driverLiveLocationsTable = pgTable("driver_live_locations", {
    id: serial("id").primaryKey(),
    driverId: integer("driver_id").notNull().references(() => staffTable.id, { onDelete: "cascade" }),
    lat: numeric("lat", { precision: 10, scale: 7 }).notNull(),
    lng: numeric("lng", { precision: 10, scale: 7 }).notNull(),
    speed: numeric("speed", { precision: 5, scale: 2 }),
    accuracy: numeric("accuracy", { precision: 6, scale: 2 }),
    heading: numeric("heading", { precision: 5, scale: 2 }),
    lastUpdated: timestamp("last_updated").defaultNow().notNull(),
});

export const insertDriverLiveLocationSchema = createInsertSchema(driverLiveLocationsTable)
    .omit({ id: true, lastUpdated: true });