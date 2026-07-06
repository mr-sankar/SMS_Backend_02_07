import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import pg from "pg";
import * as schema from "./schema";
const { Pool } = pg;
function findLocalSchemaPath() {
    const candidates = [
        path.resolve(process.cwd(), "drizzle/0000_clear_gateway.sql"),
        path.resolve(process.cwd(), "backend/drizzle/0000_clear_gateway.sql"),
        path.resolve(process.cwd(), "../drizzle/0000_clear_gateway.sql"),
        path.resolve(import.meta.dirname || (typeof __dirname !== 'undefined' ? __dirname : '.'), "../drizzle/0000_clear_gateway.sql"),
        path.resolve(process.cwd(), "../../lib/db/drizzle/0000_clear_gateway.sql"),
        path.resolve(process.cwd(), "../lib/db/drizzle/0000_clear_gateway.sql"),
        path.resolve(process.cwd(), "lib/db/drizzle/0000_clear_gateway.sql"),
        path.resolve(process.cwd(), "../db/drizzle/0000_clear_gateway.sql")
    ];
    const schemaPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!schemaPath) {
        throw new Error(`Local PGlite schema file not found. Checked: ${candidates.join(", ")}`);
    }
    return schemaPath;
}
async function bootstrapLocalDb(client) {
    const execSql = async (sql) => {
        if (typeof client.exec === "function") {
            await client.exec(sql);
        } else {
            await client.query(sql);
        }
    };
    await execSql(`
    CREATE TABLE IF NOT EXISTS "__local_migrations" (
      "id" text PRIMARY KEY NOT NULL,
      "applied_at" timestamp DEFAULT now() NOT NULL
    );
  `);
    const migrationId = "0000_clear_gateway";
    const applied = await client.query(`SELECT "id" FROM "__local_migrations" WHERE "id" = $1 LIMIT 1`, [migrationId]);
    if (applied.rows.length === 0) {
        try {
            const sql = fs
                .readFileSync(findLocalSchemaPath(), "utf8")
                .replaceAll("--> statement-breakpoint", "");
            await execSql(sql);
            await client.query(`INSERT INTO "__local_migrations" ("id") VALUES ($1)`, [
                migrationId,
            ]);
        } catch (err) {
            console.log("Base migration failed (likely tables already exist), skipping base creation:", err.message);
            try {
                await client.query(`INSERT INTO "__local_migrations" ("id") VALUES ($1)`, [
                    migrationId,
                ]);
            } catch (e) {
                // ignore
            }
        }
    }

    // Ensure all optional admission columns are present
    await execSql(`
        -- 1. Create tables first
        CREATE TABLE IF NOT EXISTS "school_settings" (
            "id" integer PRIMARY KEY DEFAULT 1,
            "name" text NOT NULL,
            "logo_url" text,
            "school_start_time" text DEFAULT '10:00' NOT NULL,
            "school_end_time" text DEFAULT '17:30' NOT NULL,
            "updated_at" timestamp DEFAULT now() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS "fee_payments" (
            "id" serial PRIMARY KEY NOT NULL,
            "fee_record_id" integer NOT NULL,
            "student_id" integer NOT NULL,
            "amount" numeric(10, 2) NOT NULL,
            "payment_method" varchar(30) NOT NULL,
            "payment_mode" varchar(20) DEFAULT 'offline' NOT NULL,
            "receipt_number" varchar(50) NOT NULL,
            "transaction_reference" varchar(100),
            "notes" text,
            "paid_at" timestamp DEFAULT now() NOT NULL,
            "collected_by" integer,
            "created_at" timestamp DEFAULT now() NOT NULL
        );
        
        CREATE TABLE IF NOT EXISTS "staff_attendance" (
            "id" serial PRIMARY KEY NOT NULL,
            "staff_id" integer NOT NULL,
            "date" text NOT NULL,
            "status" varchar(20) NOT NULL,
            "remarks" text,
            "check_in_time" text,
            "check_out_time" text,
            "late_reason" text,
            "early_checkout_reason" text,
            "created_at" timestamp DEFAULT now() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS "period_attendance" (
            "id" serial PRIMARY KEY NOT NULL,
            "student_id" integer NOT NULL,
            "class_id" integer NOT NULL,
            "timetable_slot_id" integer NOT NULL,
            "date" text NOT NULL,
            "status" varchar(20) NOT NULL,
            "remarks" text,
            "created_at" timestamp DEFAULT now() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS "hostels" (
            "id" serial PRIMARY KEY NOT NULL,
            "name" text NOT NULL,
            "type" varchar(20) NOT NULL,
            "capacity" integer NOT NULL,
            "address" text,
            "created_at" timestamp DEFAULT now() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS "hostel_maintenance" (
            "id" serial PRIMARY KEY NOT NULL,
            "hostel_id" integer NOT NULL,
            "room_id" integer NOT NULL,
            "student_id" integer NOT NULL,
            "issue_description" text NOT NULL,
            "category" varchar(30) NOT NULL,
            "status" varchar(20) NOT NULL DEFAULT 'pending',
            "assigned_to" text,
            "resolved_at" timestamp,
            "created_at" timestamp DEFAULT now() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS "hostel_visitors" (
            "id" serial PRIMARY KEY NOT NULL,
            "hostel_id" integer NOT NULL,
            "student_id" integer NOT NULL,
            "visitor_name" text NOT NULL,
            "relationship" text NOT NULL,
            "purpose" text NOT NULL,
            "id_type" varchar(30),
            "id_number" varchar(50),
            "date" varchar(20) NOT NULL,
            "status" varchar(20) NOT NULL DEFAULT 'pending',
            "check_in_time" text,
            "check_out_time" text,
            "created_at" timestamp DEFAULT now() NOT NULL
        );
        
        CREATE TABLE IF NOT EXISTS "phone_call_logs" (
            "id" serial PRIMARY KEY NOT NULL,
            "contact_name" text NOT NULL,
            "phone_number" text NOT NULL,
            "call_type" varchar(20) NOT NULL,
            "purpose" text,
            "follow_up_date" text,
            "remarks" text,
            "created_at" timestamp DEFAULT now() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS "postal_courier_logs" (
            "id" serial PRIMARY KEY NOT NULL,
            "type" varchar(20) NOT NULL,
            "reference_number" text,
            "sender_name" text NOT NULL,
            "receiver_name" text NOT NULL,
            "courier_service" text,
            "image_url" text,
            "dispatch_status" varchar(20) DEFAULT 'pending' NOT NULL,
            "date" text,
            "remarks" text,
            "created_at" timestamp DEFAULT now() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS "audit_logs" (
            "id" serial PRIMARY KEY NOT NULL,
            "user_id" integer,
            "action" varchar(255) NOT NULL,
            "ip_address" varchar(45),
            "user_agent" text,
            "payload" jsonb,
            "created_at" timestamp DEFAULT now() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS "payroll_runs" (
            "id" serial PRIMARY KEY NOT NULL,
            "staff_id" integer NOT NULL,
            "month" integer NOT NULL,
            "year" integer NOT NULL,
            "base_salary" numeric(10,2) NOT NULL,
            "allowances" numeric(10,2) DEFAULT 0,
            "deductions" numeric(10,2) DEFAULT 0,
            "net_salary" numeric(10,2) NOT NULL,
            "payment_status" varchar(50) DEFAULT 'draft',
            "paid_at" timestamp
        );

        CREATE TABLE IF NOT EXISTS "student_promotions" (
            "id" serial PRIMARY KEY NOT NULL,
            "student_id" integer NOT NULL,
            "from_class_id" integer NOT NULL,
            "to_class_id" integer NOT NULL,
            "academic_year" varchar(50) NOT NULL,
            "promoted_by" integer NOT NULL,
            "promoted_at" timestamp DEFAULT now() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS "salary_months" (
            "id" serial PRIMARY KEY NOT NULL,
            "month" integer NOT NULL,
            "year" integer NOT NULL,
            "status" varchar(50) DEFAULT 'generated' NOT NULL,
            "created_at" timestamp DEFAULT now() NOT NULL
        );
        
        CREATE TABLE IF NOT EXISTS "staff_salaries" (
            "id" serial PRIMARY KEY NOT NULL,
            "staff_id" integer NOT NULL,
            "gross_salary" numeric(10,2) NOT NULL,
            "basic_salary" numeric(10,2) NOT NULL,
            "pf" numeric(10,2) NOT NULL,
            "pt" numeric(10,2) NOT NULL,
            "leave_days" numeric(5,2) DEFAULT 0.00 NOT NULL,
            "leave_deduction" numeric(10,2) NOT NULL,
            "total_deduction" numeric(10,2) NOT NULL,
            "net_salary" numeric(10,2) NOT NULL,
            "payment_status" varchar(50) DEFAULT 'Pending' NOT NULL,
            "payment_date" timestamp,
            "paid_by" text,
            "transaction_reference" text,
            "remarks" text,
            "month" integer NOT NULL,
            "year" integer NOT NULL,
            "created_at" timestamp DEFAULT now() NOT NULL
        );
        
        CREATE TABLE IF NOT EXISTS "payslips" (
            "id" serial PRIMARY KEY NOT NULL,
            "salary_id" integer NOT NULL,
            "staff_id" integer NOT NULL,
            "payslip_number" varchar(100) UNIQUE NOT NULL,
            "pdf_url" text,
            "generated_at" timestamp DEFAULT now() NOT NULL
        );
        
        CREATE TABLE IF NOT EXISTS "salary_notifications" (
            "id" serial PRIMARY KEY NOT NULL,
            "staff_id" integer NOT NULL,
            "title" text NOT NULL,
            "message" text NOT NULL,
            "is_read" boolean DEFAULT false NOT NULL,
            "created_at" timestamp DEFAULT now() NOT NULL
        );

        -- 2. Alter tables next
        ALTER TABLE "school_settings" ADD COLUMN IF NOT EXISTS "school_start_time" text DEFAULT '10:00' NOT NULL;
        ALTER TABLE "school_settings" ADD COLUMN IF NOT EXISTS "school_end_time" text DEFAULT '17:30' NOT NULL;

        ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "parent_id" text;
        ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "address" text;
        CREATE UNIQUE INDEX IF NOT EXISTS "users_parent_id_unique" ON "users" ("parent_id");
        
        ALTER TABLE "admissions" ADD COLUMN IF NOT EXISTS "test_status" varchar(30) DEFAULT 'not_assigned';
        ALTER TABLE "admissions" ADD COLUMN IF NOT EXISTS "test_date" text;
        ALTER TABLE "admissions" ADD COLUMN IF NOT EXISTS "test_score" text;
        ALTER TABLE "admissions" ADD COLUMN IF NOT EXISTS "interview_score" text;
        ALTER TABLE "admissions" ADD COLUMN IF NOT EXISTS "merit_list_included" text;
        ALTER TABLE "admissions" ADD COLUMN IF NOT EXISTS "merit_rank" text;
        ALTER TABLE "admissions" ADD COLUMN IF NOT EXISTS "academic_year" varchar(20);
        
        ALTER TABLE "assignment_submissions" ADD COLUMN IF NOT EXISTS "attachment_url" text;
        ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "attachment_url" text;
        ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "attachment_name" text;
        ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "attachment_mime_type" text;
        ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "attachment_data" bytea;
        ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "attachment_size" text;
        
        ALTER TABLE "assignment_submissions" ADD COLUMN IF NOT EXISTS "attachment_name" text;
        ALTER TABLE "assignment_submissions" ADD COLUMN IF NOT EXISTS "attachment_mime_type" text;
        ALTER TABLE "assignment_submissions" ADD COLUMN IF NOT EXISTS "attachment_data" bytea;
        ALTER TABLE "assignment_submissions" ADD COLUMN IF NOT EXISTS "attachment_size" text;
        ALTER TABLE "assignment_submissions" ADD COLUMN IF NOT EXISTS "status" varchar(20) DEFAULT 'submitted' NOT NULL;
        
        ALTER TABLE "admission_inquiries" ADD COLUMN IF NOT EXISTS "source" varchar(50) DEFAULT 'Website' NOT NULL;
        ALTER TABLE "hostel_applications" ADD COLUMN IF NOT EXISTS "bed" varchar(20);
        
        ALTER TABLE "study_materials" ADD COLUMN IF NOT EXISTS "view_count" integer DEFAULT 0;
        ALTER TABLE "study_materials" ADD COLUMN IF NOT EXISTS "download_count" integer DEFAULT 0;
        ALTER TABLE "study_materials" ADD COLUMN IF NOT EXISTS "file_name" text;
        ALTER TABLE "study_materials" ADD COLUMN IF NOT EXISTS "mime_type" text;
        ALTER TABLE "study_materials" ADD COLUMN IF NOT EXISTS "file_data" bytea;
        
        ALTER TABLE "lesson_plans" ADD COLUMN IF NOT EXISTS "file_name" text;
        ALTER TABLE "lesson_plans" ADD COLUMN IF NOT EXISTS "mime_type" text;
        ALTER TABLE "lesson_plans" ADD COLUMN IF NOT EXISTS "file_data" bytea;
        ALTER TABLE "lesson_plans" ADD COLUMN IF NOT EXISTS "file_size" text;
        ALTER TABLE "lesson_plans" ADD COLUMN IF NOT EXISTS "lesson_order" integer;
        
        ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "documents" jsonb DEFAULT '[]'::jsonb NOT NULL;
        ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "academic_year" varchar(20);
        ALTER TABLE "students" ALTER COLUMN "class_id" DROP NOT NULL;
        ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "last_class_id" integer;
        
        ALTER TABLE "postal_courier_logs" ADD COLUMN IF NOT EXISTS "image_url" text;
        
        ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "check_in_time" text;
        ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "check_out_time" text;
        ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "late_reason" text;
        ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "early_checkout_reason" text;
        
        ALTER TABLE "behavior_logs" ADD COLUMN IF NOT EXISTS "class_id" integer;

        ALTER TABLE "exams" ADD COLUMN IF NOT EXISTS "start_time" text;
        ALTER TABLE "exams" ADD COLUMN IF NOT EXISTS "end_time" text;
        ALTER TABLE "exams" ADD COLUMN IF NOT EXISTS "room" text;
        ALTER TABLE "exams" ADD COLUMN IF NOT EXISTS "is_supply" boolean DEFAULT false;
        ALTER TABLE "exams" ADD COLUMN IF NOT EXISTS "original_exam_id" integer;
        
        ALTER TABLE "exam_results" ADD COLUMN IF NOT EXISTS "is_supplementary" boolean DEFAULT false;
        ALTER TABLE "exam_results" ADD COLUMN IF NOT EXISTS "original_marks" numeric;

        ALTER TABLE "fee_records" ADD COLUMN IF NOT EXISTS "concession" varchar(20) DEFAULT '0';
        ALTER TABLE "fee_records" ADD COLUMN IF NOT EXISTS "term_type" varchar(50) DEFAULT 'Annual';
        ALTER TABLE "fee_records" ADD COLUMN IF NOT EXISTS "fee_structure_id" integer;
        ALTER TABLE "fee_records" ADD COLUMN IF NOT EXISTS "gross_amount" numeric(10, 2);
        ALTER TABLE "fee_records" ADD COLUMN IF NOT EXISTS "concession_type" varchar(50);
        ALTER TABLE "fee_records" ADD COLUMN IF NOT EXISTS "concession_reason" text;
        ALTER TABLE "fee_records" ADD COLUMN IF NOT EXISTS "installment_label" varchar(80);
        
        ALTER TABLE "hostel_visitors" ADD COLUMN IF NOT EXISTS "id_type" varchar(30);
        ALTER TABLE "hostel_visitors" ADD COLUMN IF NOT EXISTS "id_number" varchar(50);
        
        ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "vendor_id" varchar(50) UNIQUE;
        ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "bank_account" text;
        ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "documents" jsonb DEFAULT '[]'::jsonb;
        ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "contracts" jsonb DEFAULT '[]'::jsonb;
        ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "renewal_status" varchar(50) DEFAULT 'active';
        ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "renewal_date" text;
        ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "communication_log" jsonb DEFAULT '[]'::jsonb;

        ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "source_role" varchar(50) DEFAULT 'admin' NOT NULL;
        ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "created_by" integer;
        ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "admin_accepted_at" timestamp;
        ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "admin_accepted_by" integer;
        ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "vendor_confirmed_at" timestamp;
        ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "vendor_confirmed_by" integer;
        
        ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "publish_at" timestamp;
        ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "attachment_url" text;
        ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "attachment_name" text;
        
        ALTER TABLE "hostel_rooms" ADD COLUMN IF NOT EXISTS "hostel_id" integer;
        
        ALTER TABLE "staff_attendance" ADD COLUMN IF NOT EXISTS "late_reason" text;
        ALTER TABLE "staff_attendance" ADD COLUMN IF NOT EXISTS "early_checkout_reason" text;

        ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "monthly_salary" numeric(10,2);
        
        UPDATE "staff" SET "monthly_salary" = "salary" WHERE "monthly_salary" IS NULL AND "salary" IS NOT NULL;
    `);
}
async function createConnection() {
    if (process.env.DATABASE_URL) {
        console.log("Connecting to PostgreSQL database via DATABASE_URL...");
        const pool = new Pool({ connectionString: process.env.DATABASE_URL });
        try {
            await bootstrapLocalDb(pool);
            return { db: drizzleNodePostgres(pool, { schema }), pool };
        } catch (err) {
            console.error("Failed to connect to PostgreSQL via DATABASE_URL:", err?.message ?? err);
            console.error("Falling back to local PGlite database.");
            try {
                await pool.end();
            } catch (closeErr) {
                console.warn("Unable to close PostgreSQL pool after failure:", closeErr?.message ?? closeErr);
            }
        }
    }
    console.log("Connecting to local in-memory PGlite database...");
    // Determine root directory to store pglite database
    const dataDir = process.env.PGLITE_DATA_DIR ?? (process.env.VERCEL ? "/tmp/pglite" : path.resolve(process.cwd(), ".local/pglite"));
    fs.mkdirSync(path.dirname(dataDir), { recursive: true });
    const client = new PGlite(dataDir);
    await bootstrapLocalDb(client);
    return { db: drizzlePglite(client, { schema }), pool: client };
}
const connection = await createConnection();
export const pool = connection.pool;
export const db = connection.db;
export * from "./schema";
