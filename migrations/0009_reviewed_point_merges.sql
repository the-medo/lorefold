CREATE TABLE "point_merges" (
	"book_id" text NOT NULL,
	"first_fact_id" text NOT NULL,
	"second_fact_id" text NOT NULL,
	CONSTRAINT "point_merges_book_id_first_fact_id_second_fact_id_pk" PRIMARY KEY("book_id","first_fact_id","second_fact_id"),
	CONSTRAINT "distinct_merge_facts" CHECK ("point_merges"."first_fact_id" <> "point_merges"."second_fact_id")
);
--> statement-breakpoint
ALTER TABLE "point_merges" ADD CONSTRAINT "point_merges_book_id_first_fact_id_entity_facts_book_id_id_fk" FOREIGN KEY ("book_id","first_fact_id") REFERENCES "public"."entity_facts"("book_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "point_merges" ADD CONSTRAINT "point_merges_book_id_second_fact_id_entity_facts_book_id_id_fk" FOREIGN KEY ("book_id","second_fact_id") REFERENCES "public"."entity_facts"("book_id","id") ON DELETE cascade ON UPDATE no action;