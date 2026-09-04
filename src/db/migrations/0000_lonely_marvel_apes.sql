CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"arxiv_id" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"parser_version" text NOT NULL,
	"content_hash" text NOT NULL,
	"text_length" integer NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"path" text NOT NULL,
	"title" text NOT NULL,
	"level" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"content_hash" text NOT NULL,
	CONSTRAINT "sections_span_valid" CHECK ("sections"."char_end" > "sections"."char_start" and "sections"."char_start" >= 0)
);
--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_arxiv_id_version_idx" ON "documents" USING btree ("arxiv_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "sections_document_ordinal_idx" ON "sections" USING btree ("document_id","ordinal");--> statement-breakpoint
CREATE INDEX "sections_document_idx" ON "sections" USING btree ("document_id");