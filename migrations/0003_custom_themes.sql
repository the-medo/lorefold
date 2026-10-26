CREATE TABLE "themes" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "universe_theme_preferences" (
	"universe_id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"theme_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_theme_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"theme_id" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "theme_owner_identity" ON "themes" USING btree ("id","owner_id");
--> statement-breakpoint
ALTER TABLE "themes" ADD CONSTRAINT "themes_owner_id_app_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "universe_theme_preferences" ADD CONSTRAINT "universe_theme_preferences_universe_id_owner_id_universes_id_owner_id_fk" FOREIGN KEY ("universe_id","owner_id") REFERENCES "public"."universes"("id","owner_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "universe_theme_preferences" ADD CONSTRAINT "universe_theme_preferences_theme_id_owner_id_themes_id_owner_id_fk" FOREIGN KEY ("theme_id","owner_id") REFERENCES "public"."themes"("id","owner_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_theme_preferences" ADD CONSTRAINT "user_theme_preferences_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_theme_preferences" ADD CONSTRAINT "user_theme_preferences_theme_id_user_id_themes_id_owner_id_fk" FOREIGN KEY ("theme_id","user_id") REFERENCES "public"."themes"("id","owner_id") ON DELETE cascade ON UPDATE no action;
