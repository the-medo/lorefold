CREATE TABLE "entity_matches" (
	"id" text PRIMARY KEY NOT NULL,
	"book_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"chapter" integer NOT NULL,
	"evidence_id" text NOT NULL,
	"other_book_id" text NOT NULL,
	"other_entity_id" text NOT NULL,
	"other_chapter" integer NOT NULL,
	"other_evidence_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"book_id" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"mode" text NOT NULL,
	"model" text NOT NULL,
	"effort" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"run_token" text,
	"pause_requested" boolean DEFAULT false NOT NULL,
	"total_parts" integer DEFAULT 0 NOT NULL,
	"completed_parts" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"error" text,
	"retryable" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_status" CHECK ("import_jobs"."status" in ('queued','extracting','analyzing','paused','failed','complete')),
	CONSTRAINT "import_mode" CHECK ("import_jobs"."mode" in ('mock','chatgpt-plan','gateway'))
);
--> statement-breakpoint
CREATE TABLE "import_parts" (
	"book_id" text NOT NULL,
	"chapter" integer NOT NULL,
	"part" integer NOT NULL,
	"source_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"request" jsonb,
	"response" jsonb,
	"error" text,
	CONSTRAINT "import_parts_book_id_chapter_part_pk" PRIMARY KEY("book_id","chapter","part")
);
--> statement-breakpoint
ALTER TABLE "chapters" ADD COLUMN "text_key" text;--> statement-breakpoint
ALTER TABLE "chapters" ADD COLUMN "recap_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "entity_matches" ADD CONSTRAINT "entity_matches_book_id_entity_id_entities_book_id_id_fk" FOREIGN KEY ("book_id","entity_id") REFERENCES "public"."entities"("book_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_matches" ADD CONSTRAINT "entity_matches_other_book_id_other_entity_id_entities_book_id_id_fk" FOREIGN KEY ("other_book_id","other_entity_id") REFERENCES "public"."entities"("book_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_matches" ADD CONSTRAINT "entity_matches_book_id_evidence_id_evidence_book_id_id_fk" FOREIGN KEY ("book_id","evidence_id") REFERENCES "public"."evidence"("book_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_matches" ADD CONSTRAINT "entity_matches_other_book_id_other_evidence_id_evidence_book_id_id_fk" FOREIGN KEY ("other_book_id","other_evidence_id") REFERENCES "public"."evidence"("book_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_parts" ADD CONSTRAINT "import_parts_book_id_import_jobs_book_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."import_jobs"("book_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_parts" ADD CONSTRAINT "import_parts_book_id_chapter_chapters_book_id_number_fk" FOREIGN KEY ("book_id","chapter") REFERENCES "public"."chapters"("book_id","number") ON DELETE cascade ON UPDATE no action;