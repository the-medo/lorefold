CREATE TABLE "point_merge_scans" (
	"book_id" text PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"status" text NOT NULL,
	"mode" text NOT NULL,
	"preference" jsonb NOT NULL,
	"plan" jsonb,
	"applied" integer DEFAULT 0 NOT NULL,
	"error" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "point_merge_scans" ADD CONSTRAINT "point_merge_scans_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;