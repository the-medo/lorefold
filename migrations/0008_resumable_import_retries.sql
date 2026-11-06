CREATE TABLE "import_failures" (
	"book_id" text NOT NULL,
	"chapter" integer NOT NULL,
	"part" integer NOT NULL,
	"attempt" integer NOT NULL,
	"error" text NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_failures_book_id_chapter_part_attempt_pk" PRIMARY KEY("book_id","chapter","part","attempt")
);
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "next_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_failures" ADD CONSTRAINT "import_failures_book_id_chapter_part_import_parts_book_id_chapter_part_fk" FOREIGN KEY ("book_id","chapter","part") REFERENCES "public"."import_parts"("book_id","chapter","part") ON DELETE cascade ON UPDATE no action;