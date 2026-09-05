CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"config" jsonb NOT NULL,
	"metrics" jsonb,
	"classifier_enabled" boolean NOT NULL,
	"verifier_enabled" boolean NOT NULL,
	"model" text NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "injections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"source_arxiv_id" text NOT NULL,
	"document_id" uuid,
	"mutation_type" text NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"original_text" text NOT NULL,
	"mutated_text" text NOT NULL,
	"counterpart_start" integer NOT NULL,
	"counterpart_end" integer NOT NULL,
	"section_path" text NOT NULL,
	"detected" boolean,
	"matched_finding" jsonb,
	"note" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "eval_run_id" uuid;--> statement-breakpoint
ALTER TABLE "injections" ADD CONSTRAINT "injections_run_id_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "injections" ADD CONSTRAINT "injections_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "injections_run_idx" ON "injections" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "injections_type_idx" ON "injections" USING btree ("mutation_type");--> statement-breakpoint
CREATE INDEX "documents_eval_run_idx" ON "documents" USING btree ("eval_run_id");