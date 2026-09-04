CREATE TABLE "classification_cache" (
	"content_hash" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "classification_cache_key_idx" ON "classification_cache" USING btree ("content_hash","model","prompt_version");