CREATE TABLE "user_ai_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"model" text DEFAULT 'gpt-6-astra' NOT NULL,
	"effort" text DEFAULT 'high' NOT NULL,
	CONSTRAINT "analysis_model" CHECK ("user_ai_preferences"."model" in ('gpt-6-astra', 'gpt-6.1-sol')),
	CONSTRAINT "analysis_effort" CHECK ("user_ai_preferences"."effort" in ('medium', 'high', 'xhigh'))
);
--> statement-breakpoint
ALTER TABLE "user_ai_preferences" ADD CONSTRAINT "user_ai_preferences_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;