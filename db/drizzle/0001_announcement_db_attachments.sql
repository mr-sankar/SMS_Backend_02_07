ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "publish_at" timestamp;
--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "attachment_url" text;
--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "attachment_name" text;
--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "attachment_mime_type" text;
--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "attachment_data" bytea;
--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "attachment_size" text;
