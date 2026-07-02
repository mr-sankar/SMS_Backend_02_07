import {
    pgTable,
    serial,
    text,
    integer,
    timestamp,
    varchar,
    date,
    uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

// ─── Student class attendance (unchanged) ─────────────────────────────────────
export const attendanceTable = pgTable("attendance", {
    id:          serial("id").primaryKey(),
    studentId:   integer("student_id").notNull(),
    classId:     integer("class_id").notNull(),
    date:        date("date").notNull(),
    status:      varchar("status", { length: 20 }).notNull(),
    remarks:     text("remarks"),
    markedById:  integer("marked_by_id"),
    createdAt:   timestamp("created_at").defaultNow().notNull(),
});

// ─── Staff daily attendance summary (unchanged) ───────────────────────────────
export const staffAttendanceTable = pgTable("staff_attendance", {
    id:           serial("id").primaryKey(),
    staffId:      integer("staff_id").notNull(),
    date:         date("date").notNull(),
    status:       varchar("status", { length: 20 }).notNull(),
    remarks:      text("remarks"),
    checkInTime:  text("check_in_time"),
    checkOutTime: text("check_out_time"),
    createdAt:    timestamp("created_at").defaultNow().notNull(),
});

// ─── Period attendance (unchanged) ────────────────────────────────────────────
export const periodAttendanceTable = pgTable("period_attendance", {
    id:               serial("id").primaryKey(),
    studentId:        integer("student_id").notNull(),
    classId:          integer("class_id").notNull(),
    timetableSlotId:  integer("timetable_slot_id").notNull(),
    date:             date("date").notNull(),
    status:           varchar("status", { length: 20 }).notNull(),
    remarks:          text("remarks"),
    createdAt:        timestamp("created_at").defaultNow().notNull(),
});

// ─── NEW: Dashboard check-in / check-out (one row per user per day) ───────────
// Separate from staffAttendanceTable so existing payroll/HR logic is untouched.
// userId links to usersTable.id (works for any role — teacher, warden, driver…)
export const staffCheckinsTable = pgTable(
    "staff_checkins",
    {
        id:             serial("id").primaryKey(),
        userId:         integer("user_id").notNull(),          // usersTable.id
        date:           date("date").notNull(),                // "YYYY-MM-DD"
        checkInTime:    timestamp("check_in_time"),
        checkOutTime:   timestamp("check_out_time"),
        checkInReason:  text("check_in_reason"),              // null = on-time
        checkOutReason: text("check_out_reason"),             // null = on-time
        createdAt:      timestamp("created_at").defaultNow().notNull(),
    },
    (t) => ({
        // Enforce one record per user per day at the DB level
        uniqUserDate: uniqueIndex("staff_checkins_user_date_uniq").on(t.userId, t.date),
    })
);

// ─── Zod insert schemas ───────────────────────────────────────────────────────
export const insertAttendanceSchema       = createInsertSchema(attendanceTable).omit({ id: true, createdAt: true });
export const insertStaffAttendanceSchema  = createInsertSchema(staffAttendanceTable).omit({ id: true, createdAt: true });
export const insertPeriodAttendanceSchema = createInsertSchema(periodAttendanceTable).omit({ id: true, createdAt: true });
export const insertStaffCheckinSchema     = createInsertSchema(staffCheckinsTable).omit({ id: true, createdAt: true });