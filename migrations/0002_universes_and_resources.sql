CREATE TABLE "resources" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"universe_id" text NOT NULL,
	"book_id" text,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resources_book_id_unique" UNIQUE("book_id"),
	CONSTRAINT "resources_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "resource_kind" CHECK ("resources"."kind" in ('book', 'document')),
	CONSTRAINT "resource_book_kind" CHECK (("resources"."kind" = 'book') = ("resources"."book_id" is not null)),
	CONSTRAINT "resource_size" CHECK ("resources"."byte_size" > 0 and "resources"."byte_size" <= 26214400)
);
--> statement-breakpoint
CREATE TABLE "universes" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "universe_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "universe_owner_identity" ON "universes" USING btree ("id","owner_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "book_universe_owner_identity" ON "books" USING btree ("id","universe_id","owner_id");
--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_owner_id_app_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_universe_id_owner_id_universes_id_owner_id_fk" FOREIGN KEY ("universe_id","owner_id") REFERENCES "public"."universes"("id","owner_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_book_id_universe_id_owner_id_books_id_universe_id_owner_id_fk" FOREIGN KEY ("book_id","universe_id","owner_id") REFERENCES "public"."books"("id","universe_id","owner_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "universes" ADD CONSTRAINT "universes_owner_id_app_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_universe_id_owner_id_universes_id_owner_id_fk" FOREIGN KEY ("universe_id","owner_id") REFERENCES "public"."universes"("id","owner_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO universes (id, owner_id, name, description)
SELECT 'sample-universe-' || owner_id, owner_id, 'Bellweather',
  'A fogbound coast, a wayward compass, and stories carried by the tide.'
FROM books WHERE id = 'sample-' || owner_id
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
UPDATE books SET universe_id = 'sample-universe-' || owner_id
WHERE id = 'sample-' || owner_id AND universe_id IS NULL;
