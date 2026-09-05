CREATE TABLE "verification_cache" (
	"content_hash" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "verification_cache_key_idx" ON "verification_cache" USING btree ("content_hash","model","prompt_version");