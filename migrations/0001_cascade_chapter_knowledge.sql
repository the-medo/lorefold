ALTER TABLE "entity_facts" DROP CONSTRAINT "entity_facts_book_id_reveal_chapter_chapters_book_id_number_fk";
--> statement-breakpoint
ALTER TABLE "relationships" DROP CONSTRAINT "relationships_book_id_reveal_chapter_chapters_book_id_number_fk";
--> statement-breakpoint
ALTER TABLE "entity_facts" ADD CONSTRAINT "entity_facts_book_id_reveal_chapter_chapters_book_id_number_fk" FOREIGN KEY ("book_id","reveal_chapter") REFERENCES "public"."chapters"("book_id","number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_book_id_reveal_chapter_chapters_book_id_number_fk" FOREIGN KEY ("book_id","reveal_chapter") REFERENCES "public"."chapters"("book_id","number") ON DELETE cascade ON UPDATE no action;