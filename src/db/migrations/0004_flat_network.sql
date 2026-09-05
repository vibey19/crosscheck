CREATE TABLE "embedding_cache" (
	"content_hash" text NOT NULL,
	"model" text NOT NULL,
	"dims" integer NOT NULL,
	"embedding" vector(768) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_cache_key_idx" ON "embedding_cache" USING btree ("content_hash","model","dims");