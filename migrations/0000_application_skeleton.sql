CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_appearances" (
	"book_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"chapter" integer NOT NULL,
	CONSTRAINT "entity_appearances_book_id_entity_id_chapter_pk" PRIMARY KEY("book_id","entity_id","chapter")
);
--> statement-breakpoint
CREATE TABLE "books" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"author" text NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chapters" (
	"book_id" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"text" text NOT NULL,
	"recap" text NOT NULL,
	"developments" jsonb NOT NULL,
	"analyzed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "chapters_book_id_number_pk" PRIMARY KEY("book_id","number"),
	CONSTRAINT "chapter_positive" CHECK ("chapters"."number" > 0)
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"book_id" text NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "entities_book_id_id_pk" PRIMARY KEY("book_id","id")
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"book_id" text NOT NULL,
	"id" text NOT NULL,
	"chapter" integer NOT NULL,
	"quote" text NOT NULL,
	CONSTRAINT "evidence_book_id_id_pk" PRIMARY KEY("book_id","id")
);
--> statement-breakpoint
CREATE TABLE "entity_facts" (
	"book_id" text NOT NULL,
	"id" text NOT NULL,
	"entity_id" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"reveal_chapter" integer NOT NULL,
	"evidence_id" text NOT NULL,
	"extraction_version" text DEFAULT 'synthetic-v1' NOT NULL,
	CONSTRAINT "entity_facts_book_id_id_pk" PRIMARY KEY("book_id","id")
);
--> statement-breakpoint
CREATE TABLE "reader_progress" (
	"book_id" text NOT NULL,
	"user_id" text NOT NULL,
	"completed_chapter" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reader_progress_book_id_user_id_pk" PRIMARY KEY("book_id","user_id"),
	CONSTRAINT "progress_nonnegative" CHECK ("reader_progress"."completed_chapter" >= 0)
);
--> statement-breakpoint
CREATE TABLE "relationships" (
	"book_id" text NOT NULL,
	"id" text NOT NULL,
	"source_id" text NOT NULL,
	"target_id" text NOT NULL,
	"label" text NOT NULL,
	"reveal_chapter" integer NOT NULL,
	"evidence_id" text NOT NULL,
	"extraction_version" text DEFAULT 'synthetic-v1' NOT NULL,
	CONSTRAINT "relationships_book_id_id_pk" PRIMARY KEY("book_id","id")
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_appearances" ADD CONSTRAINT "entity_appearances_book_id_entity_id_entities_book_id_id_fk" FOREIGN KEY ("book_id","entity_id") REFERENCES "public"."entities"("book_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_appearances" ADD CONSTRAINT "entity_appearances_book_id_chapter_chapters_book_id_number_fk" FOREIGN KEY ("book_id","chapter") REFERENCES "public"."chapters"("book_id","number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_owner_id_app_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_book_id_chapter_chapters_book_id_number_fk" FOREIGN KEY ("book_id","chapter") REFERENCES "public"."chapters"("book_id","number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_facts" ADD CONSTRAINT "entity_facts_book_id_entity_id_entities_book_id_id_fk" FOREIGN KEY ("book_id","entity_id") REFERENCES "public"."entities"("book_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_facts" ADD CONSTRAINT "entity_facts_book_id_evidence_id_evidence_book_id_id_fk" FOREIGN KEY ("book_id","evidence_id") REFERENCES "public"."evidence"("book_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_facts" ADD CONSTRAINT "entity_facts_book_id_reveal_chapter_chapters_book_id_number_fk" FOREIGN KEY ("book_id","reveal_chapter") REFERENCES "public"."chapters"("book_id","number") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_progress" ADD CONSTRAINT "reader_progress_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_progress" ADD CONSTRAINT "reader_progress_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_book_id_source_id_entities_book_id_id_fk" FOREIGN KEY ("book_id","source_id") REFERENCES "public"."entities"("book_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_book_id_target_id_entities_book_id_id_fk" FOREIGN KEY ("book_id","target_id") REFERENCES "public"."entities"("book_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_book_id_evidence_id_evidence_book_id_id_fk" FOREIGN KEY ("book_id","evidence_id") REFERENCES "public"."evidence"("book_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_book_id_reveal_chapter_chapters_book_id_number_fk" FOREIGN KEY ("book_id","reveal_chapter") REFERENCES "public"."chapters"("book_id","number") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_identity" ON "auth_account" USING btree ("provider_id","account_id");