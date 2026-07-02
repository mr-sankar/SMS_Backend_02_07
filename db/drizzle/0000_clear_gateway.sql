-- =============================================
-- COMPLETE DATABASE SCHEMA WITH UNIQUE EMAILS
-- =============================================

-- Users table - Added unique email constraint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" varchar(100) NOT NULL,
	"password" text NOT NULL,
	"role" varchar(50) NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"parent_id" text,
	"address" text,
	"avatar_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_parent_id_unique" UNIQUE("parent_id")
);

-- Students table - Added unique email constraint
CREATE TABLE "students" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"roll_number" varchar(50) NOT NULL,
	"class_id" integer NOT NULL,
	"gender" varchar(20) NOT NULL,
	"date_of_birth" date,
	"phone" text,
	"email" text,
	"parent_name" text,
	"parent_phone" text,
	"address" text,
	"status" varchar(30) DEFAULT 'active' NOT NULL,
	"admission_date" date NOT NULL,
	"academic_year" varchar(20),
	"avatar_url" text,
	"user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "students_roll_number_unique" UNIQUE("roll_number"),
	CONSTRAINT "students_email_unique" UNIQUE("email")
);

-- Staff table - Added unique email constraint
CREATE TABLE "staff" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_id" text,
	"name" text NOT NULL,
	// Add to staffTable
dob: date("dob"),
	"role" varchar(50) NOT NULL,
	"department" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"qualification" text,
	"salary" numeric(10, 2),
	"years_of_experience" integer,
	"join_date" date NOT NULL,
	"status" varchar(30) DEFAULT 'active' NOT NULL,
	"avatar_url" text,
	"user_id" integer,
	"documents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"performance_notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "staff_staff_id_unique" UNIQUE("staff_id"),
	CONSTRAINT "staff_email_unique" UNIQUE("email")
);

-- Classes table
CREATE TABLE "classes" (
	"id" serial PRIMARY KEY NOT NULL,
	"grade" varchar(20) NOT NULL,
	"section" varchar(10) NOT NULL,
	"teacher_id" integer,
	"academic_year" varchar(20) NOT NULL,
	"room" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Subjects table
CREATE TABLE "subjects" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"code" varchar(20) NOT NULL,
	"class_id" integer,
	"teacher_id" integer,
	"description" text,
	"credits" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Attendance table
CREATE TABLE "attendance" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"class_id" integer NOT NULL,
	"date" date NOT NULL,
	"status" varchar(20) NOT NULL,
	"remarks" text,
	"marked_by_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Exam Results table
CREATE TABLE "exam_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"exam_id" integer NOT NULL,
	"student_id" integer NOT NULL,
	"subject_id" integer NOT NULL,
	"marks_obtained" numeric(6, 2) NOT NULL,
	"max_marks" numeric(6, 2) NOT NULL,
	"grade" varchar(5) DEFAULT '' NOT NULL,
	"gpa" numeric(4, 2),
	"remarks" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Exams table
CREATE TABLE "exams" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" varchar(30) NOT NULL,
	"class_id" integer NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"max_marks" integer,
	"passing_marks" integer,
	"status" varchar(30) DEFAULT 'upcoming' NOT NULL,
	"is_supply" boolean DEFAULT false,
	"original_exam_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Fee Records table
CREATE TABLE "fee_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"fee_type" text NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"paid_amount" numeric(10, 2),
	"due_date" date NOT NULL,
	"paid_date" date,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"payment_method" varchar(30),
	"receipt_number" varchar(50),
	"academic_year" varchar(20) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Fee Structures table
CREATE TABLE "fee_structures" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"class_id" integer NOT NULL,
	"academic_year" varchar(20) NOT NULL,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Hostel Applications table
CREATE TABLE "hostel_applications" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"preferred_block" varchar(20) NOT NULL,
	"preferred_room_type" varchar(20) NOT NULL,
	"room_id" integer,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"remarks" text,
	"applied_at" timestamp DEFAULT now() NOT NULL
);

-- Hostel Attendance table
CREATE TABLE "hostel_attendance" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"date" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'in' NOT NULL,
	"recorded_at" timestamp DEFAULT now() NOT NULL
);

-- Hostel Meals table
CREATE TABLE "hostel_meals" (
	"id" serial PRIMARY KEY NOT NULL,
	"day" varchar(20) NOT NULL,
	"breakfast" text DEFAULT '' NOT NULL,
	"lunch" text DEFAULT '' NOT NULL,
	"dinner" text DEFAULT '' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "hostel_meals_day_unique" UNIQUE("day")
);

-- Hostel Notices table
CREATE TABLE "hostel_notices" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"urgent" boolean DEFAULT false NOT NULL,
	"posted_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Hostel Rooms table
CREATE TABLE "hostel_rooms" (
	"id" serial PRIMARY KEY NOT NULL,
	"room_number" varchar(20) NOT NULL,
	"block" varchar(20) NOT NULL,
	"floor" integer NOT NULL,
	"capacity" integer NOT NULL,
	"occupied" integer DEFAULT 0 NOT NULL,
	"type" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'available' NOT NULL,
	"facilities" text,
	"monthly_fee" numeric,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Student Transport Assignments table
CREATE TABLE "student_transport_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"route_id" integer NOT NULL,
	"pickup_stop" text,
	"drop_stop" text,
	"fee_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Transport Routes table
CREATE TABLE "transport_routes" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"start_point" text NOT NULL,
	"end_point" text NOT NULL,
	"vehicle_id" integer,
	"stops" text,
	"morning_time" text,
	"evening_time" text,
	"distance" numeric(6, 2),
	"fare" numeric(10, 2),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Vehicles table
CREATE TABLE "vehicles" (
	"id" serial PRIMARY KEY NOT NULL,
	"vehicle_number" varchar(30) NOT NULL,
	"type" varchar(20) NOT NULL,
	"capacity" integer NOT NULL,
	"driver_id" integer,
	"model" text,
	"insurance_expiry" text,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "vehicles_vehicle_number_unique" UNIQUE("vehicle_number")
);

-- Announcements table
CREATE TABLE "announcements" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"audience" varchar(30) NOT NULL,
	"class_id" integer,
	"priority" varchar(20) DEFAULT 'normal' NOT NULL,
	"author_id" integer NOT NULL,
	"publish_at" timestamp,
	"expires_at" timestamp,
	"attachment_url" text,
	"attachment_name" text,
	"attachment_mime_type" text,
	"attachment_data" bytea,
	"attachment_size" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Complaints table - Updated with submitted_by_type
CREATE TABLE "complaints" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"category" varchar(30) NOT NULL,
	"submitted_by_id" integer NOT NULL,
	"submitted_by_type" varchar(20) NOT NULL DEFAULT 'user',
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"priority" varchar(20) DEFAULT 'medium' NOT NULL,
	"assigned_to" text,
	"resolution" text,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Purchase Orders table
CREATE TABLE "purchase_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"po_number" varchar(30) NOT NULL,
	"vendor_id" integer NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_amount" numeric(12, 2) NOT NULL,
	"status" varchar(30) DEFAULT 'draft' NOT NULL,
	"source_role" varchar(50) DEFAULT 'admin' NOT NULL,
	"created_by" integer,
	"admin_accepted_at" timestamp,
	"admin_accepted_by" integer,
	"vendor_confirmed_at" timestamp,
	"vendor_confirmed_by" integer,
	"delivery_date" text,
	"notes" text,
	"invoice_url" text,
	"invoice_number" text,
	"paid_at" timestamp,
	"payment_reference" text,
	"amount_paid" numeric(12, 2),
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_po_number_unique" UNIQUE("po_number")
);

-- Vendors table - Added unique email constraint
CREATE TABLE "vendors" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"contact_person" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"gst_number" text,
	"address" text,
	"category" text,
	"status" varchar(30) DEFAULT 'pending_verification' NOT NULL,
	"rating" numeric(3, 1),
	"user_id" integer,
	"registered_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "vendors_email_unique" UNIQUE("email")
);

-- Assignments table
CREATE TABLE "assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"subject_id" integer NOT NULL,
	"class_id" integer NOT NULL,
	"due_date" text NOT NULL,
	"max_marks" integer NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"attachment_url" text,
	"created_by_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Assignment Submissions table
CREATE TABLE "assignment_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"assignment_id" integer NOT NULL,
	"student_id" integer NOT NULL,
	"notes" text,
	"submitted_at" timestamp DEFAULT now() NOT NULL
);

-- Lesson Plans table
CREATE TABLE "lesson_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"objectives" text,
	"content" text,
	"subject_id" integer NOT NULL,
	"class_id" integer NOT NULL,
	"teacher_id" integer NOT NULL,
	"week_date" text NOT NULL,
	"duration" integer,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Study Materials table
CREATE TABLE "study_materials" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"type" varchar(20) NOT NULL,
	"file_url" text,
	"file_size" text,
	"subject_id" integer NOT NULL,
	"class_id" integer NOT NULL,
	"uploaded_by_id" integer NOT NULL,
	"download_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Admissions table - Added unique parent email constraint
CREATE TABLE "admissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"applicant_name" text NOT NULL,
	"date_of_birth" text NOT NULL,
	"gender" varchar(20) NOT NULL,
	"applying_for_class" varchar(30) NOT NULL,
	"previous_school" text,
	"parent_name" text NOT NULL,
	"parent_email" text NOT NULL,
	"parent_phone" text NOT NULL,
	"address" text,
	"documents" text,
	"status" varchar(30) DEFAULT 'pending' NOT NULL,
	"remarks" text,
	"applied_at" timestamp DEFAULT now() NOT NULL,
	"reviewed_at" timestamp,
	CONSTRAINT "admissions_parent_email_unique" UNIQUE("parent_email")
);

-- Leave Requests table
CREATE TABLE "leave_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"applicant_id" integer NOT NULL,
	"applicant_type" varchar(20) NOT NULL,
	"leave_type" varchar(30) NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"reason" text NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"approved_by_id" integer,
	"remarks" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Timetable Slots table
CREATE TABLE "timetable_slots" (
	"id" serial PRIMARY KEY NOT NULL,
	"class_id" integer NOT NULL,
	"subject_id" integer NOT NULL,
	"staff_id" integer NOT NULL,
	"day_of_week" varchar(10) NOT NULL,
	"start_time" varchar(10) NOT NULL,
	"end_time" varchar(10) NOT NULL,
	"room" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Visitor Log table
CREATE TABLE "visitor_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"visitor_name" text NOT NULL,
	"visitor_phone" text,
	"purpose" text NOT NULL,
	"person_to_meet" text NOT NULL,
	"department" text,
	"id_type" varchar(30),
	"id_number" varchar(50),
	"badge" varchar(20),
	"status" varchar(20) DEFAULT 'inside' NOT NULL,
	"check_in" timestamp DEFAULT now() NOT NULL,
	"check_out" timestamp,
	"remarks" text
);

-- Library Books table
CREATE TABLE "library_books" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"author" text NOT NULL,
	"isbn" varchar(20),
	"category" varchar(50) NOT NULL,
	"total_copies" integer DEFAULT 1 NOT NULL,
	"available_copies" integer DEFAULT 1 NOT NULL,
	"publisher" text,
	"publish_year" integer,
	"shelf_location" varchar(30),
	"status" varchar(20) DEFAULT 'available' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Library Issuances table
CREATE TABLE "library_issuances" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"borrower_id" integer NOT NULL,
	"borrower_type" varchar(20) NOT NULL,
	"issue_date" date NOT NULL,
	"due_date" date NOT NULL,
	"return_date" date,
	"fine" integer DEFAULT 0,
	"status" varchar(20) DEFAULT 'issued' NOT NULL,
	"issued_by_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Library Book Requests table
CREATE TABLE "library_book_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"student_id" integer NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"handled_at" timestamp,
	"handled_by_id" integer,
	"issuance_id" integer
);

-- Behavior Logs table
CREATE TABLE "behavior_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"teacher_id" integer,
	"type" varchar(20) DEFAULT 'neutral' NOT NULL,
	"category" varchar(50) NOT NULL,
	"description" text NOT NULL,
	"date" date NOT NULL,
	"points" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Inventory Products table
CREATE TABLE "inventory_products" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" varchar(30) NOT NULL,
	"unit" varchar(20) DEFAULT 'pcs' NOT NULL,
	"current_stock" integer DEFAULT 0 NOT NULL,
	"reorder_threshold" integer DEFAULT 10 NOT NULL,
	"unit_price" numeric(10, 2),
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Stock Movements table
CREATE TABLE "stock_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"direction" varchar(10) NOT NULL,
	"quantity" integer NOT NULL,
	"reason" varchar(40) DEFAULT 'manual' NOT NULL,
	"reference" text,
	"notes" text,
	"recorded_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- =============================================
-- FOREIGN KEY CONSTRAINTS
-- =============================================

ALTER TABLE "assignment_submissions" ADD CONSTRAINT "assignment_submissions_assignment_id_assignments_id_fk" 
FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE CASCADE;

ALTER TABLE "assignment_submissions" ADD CONSTRAINT "assignment_submissions_student_id_students_id_fk" 
FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE CASCADE;

ALTER TABLE "students" ADD CONSTRAINT "students_class_id_classes_id_fk" 
FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");

ALTER TABLE "students" ADD CONSTRAINT "students_user_id_users_id_fk" 
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");

ALTER TABLE "staff" ADD CONSTRAINT "staff_user_id_users_id_fk" 
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");

ALTER TABLE "classes" ADD CONSTRAINT "classes_teacher_id_staff_id_fk" 
FOREIGN KEY ("teacher_id") REFERENCES "public"."staff"("id");

ALTER TABLE "subjects" ADD CONSTRAINT "subjects_class_id_classes_id_fk" 
FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");

ALTER TABLE "subjects" ADD CONSTRAINT "subjects_teacher_id_staff_id_fk" 
FOREIGN KEY ("teacher_id") REFERENCES "public"."staff"("id");

ALTER TABLE "attendance" ADD CONSTRAINT "attendance_student_id_students_id_fk" 
FOREIGN KEY ("student_id") REFERENCES "public"."students"("id");

ALTER TABLE "attendance" ADD CONSTRAINT "attendance_class_id_classes_id_fk" 
FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");

ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_exam_id_exams_id_fk" 
FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id");

ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_student_id_students_id_fk" 
FOREIGN KEY ("student_id") REFERENCES "public"."students"("id");

ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_subject_id_subjects_id_fk" 
FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id");

ALTER TABLE "exams" ADD CONSTRAINT "exams_class_id_classes_id_fk" 
FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");

ALTER TABLE "fee_records" ADD CONSTRAINT "fee_records_student_id_students_id_fk" 
FOREIGN KEY ("student_id") REFERENCES "public"."students"("id");

ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_class_id_classes_id_fk" 
FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");

ALTER TABLE "hostel_applications" ADD CONSTRAINT "hostel_applications_student_id_students_id_fk" 
FOREIGN KEY ("student_id") REFERENCES "public"."students"("id");

ALTER TABLE "hostel_applications" ADD CONSTRAINT "hostel_applications_room_id_hostel_rooms_id_fk" 
FOREIGN KEY ("room_id") REFERENCES "public"."hostel_rooms"("id");

ALTER TABLE "hostel_attendance" ADD CONSTRAINT "hostel_attendance_student_id_students_id_fk" 
FOREIGN KEY ("student_id") REFERENCES "public"."students"("id");

ALTER TABLE "student_transport_assignments" ADD CONSTRAINT "student_transport_assignments_student_id_students_id_fk" 
FOREIGN KEY ("student_id") REFERENCES "public"."students"("id");

ALTER TABLE "student_transport_assignments" ADD CONSTRAINT "student_transport_assignments_route_id_transport_routes_id_fk" 
FOREIGN KEY ("route_id") REFERENCES "public"."transport_routes"("id");

ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_vehicle_id_vehicles_id_fk" 
FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id");

ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_driver_id_staff_id_fk" 
FOREIGN KEY ("driver_id") REFERENCES "public"."staff"("id");

ALTER TABLE "announcements" ADD CONSTRAINT "announcements_author_id_users_id_fk" 
FOREIGN KEY ("author_id") REFERENCES "public"."users"("id");

ALTER TABLE "complaints" ADD CONSTRAINT "complaints_submitted_by_id_users_id_fk" 
FOREIGN KEY ("submitted_by_id") REFERENCES "public"."users"("id");

ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_vendors_id_fk" 
FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id");

ALTER TABLE "vendors" ADD CONSTRAINT "vendors_user_id_users_id_fk" 
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");

ALTER TABLE "assignments" ADD CONSTRAINT "assignments_subject_id_subjects_id_fk" 
FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id");

ALTER TABLE "assignments" ADD CONSTRAINT "assignments_class_id_classes_id_fk" 
FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");

ALTER TABLE "assignments" ADD CONSTRAINT "assignments_created_by_id_staff_id_fk" 
FOREIGN KEY ("created_by_id") REFERENCES "public"."staff"("id");

ALTER TABLE "lesson_plans" ADD CONSTRAINT "lesson_plans_subject_id_subjects_id_fk" 
FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id");

ALTER TABLE "lesson_plans" ADD CONSTRAINT "lesson_plans_class_id_classes_id_fk" 
FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");

ALTER TABLE "lesson_plans" ADD CONSTRAINT "lesson_plans_teacher_id_staff_id_fk" 
FOREIGN KEY ("teacher_id") REFERENCES "public"."staff"("id");

ALTER TABLE "study_materials" ADD CONSTRAINT "study_materials_subject_id_subjects_id_fk" 
FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id");

ALTER TABLE "study_materials" ADD CONSTRAINT "study_materials_class_id_classes_id_fk" 
FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");

ALTER TABLE "study_materials" ADD CONSTRAINT "study_materials_uploaded_by_id_staff_id_fk" 
FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."staff"("id");

ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_class_id_classes_id_fk" 
FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");

ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_subject_id_subjects_id_fk" 
FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id");

ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_staff_id_staff_id_fk" 
FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id");

ALTER TABLE "library_issuances" ADD CONSTRAINT "library_issuances_book_id_library_books_id_fk" 
FOREIGN KEY ("book_id") REFERENCES "public"."library_books"("id");

ALTER TABLE "library_book_requests" ADD CONSTRAINT "library_book_requests_book_id_library_books_id_fk" 
FOREIGN KEY ("book_id") REFERENCES "public"."library_books"("id");

ALTER TABLE "library_book_requests" ADD CONSTRAINT "library_book_requests_student_id_students_id_fk" 
FOREIGN KEY ("student_id") REFERENCES "public"."students"("id");

ALTER TABLE "behavior_logs" ADD CONSTRAINT "behavior_logs_student_id_students_id_fk" 
FOREIGN KEY ("student_id") REFERENCES "public"."students"("id");

ALTER TABLE "behavior_logs" ADD CONSTRAINT "behavior_logs_teacher_id_staff_id_fk" 
FOREIGN KEY ("teacher_id") REFERENCES "public"."staff"("id");

ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_inventory_products_id_fk" 
FOREIGN KEY ("product_id") REFERENCES "public"."inventory_products"("id");

-- =============================================
-- UNIQUE INDEXES
-- =============================================
CREATE UNIQUE INDEX "assign_subm_uniq" ON "assignment_submissions" USING btree ("assignment_id","student_id");

CREATE TABLE "driver_live_locations" (
    id SERIAL PRIMARY KEY,
    driver_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    lat NUMERIC(10,7) NOT NULL,
    lng NUMERIC(10,7) NOT NULL,
    speed NUMERIC(5,2),
    accuracy NUMERIC(6,2),
    heading NUMERIC(5,2),
    last_updated TIMESTAMP DEFAULT NOW() NOT NULL,
    
    UNIQUE(driver_id)
);