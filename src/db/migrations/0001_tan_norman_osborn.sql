CREATE TABLE "candidate_pairs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_a_id" uuid NOT NULL,
	"claim_b_id" uuid NOT NULL,
	"similarity" real NOT NULL,
	"survived_type_filter" boolean NOT NULL,
	"scope" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"text" text NOT NULL,
	"char_start" integer,
	"char_end" integer,
	"span_resolved" boolean DEFAULT false NOT NULL,
	"claim_type" text NOT NULL,
	"subject" text NOT NULL,
	"quantities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"embedding" vector(768),
	"content_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extraction_cache" (
	"content_hash" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"claims" jsonb NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pair_id" uuid NOT NULL,
	"conflict_type" text NOT NULL,
	"verdict" text NOT NULL,
	"confidence" double precision NOT NULL,
	"rationale" text NOT NULL,
	"detector" text NOT NULL,
	"verifier_passed" boolean,
	"spans" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "candidate_pairs" ADD CONSTRAINT "candidate_pairs_claim_a_id_claims_id_fk" FOREIGN KEY ("claim_a_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_pairs" ADD CONSTRAINT "candidate_pairs_claim_b_id_claims_id_fk" FOREIGN KEY ("claim_b_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_pair_id_candidate_pairs_id_fk" FOREIGN KEY ("pair_id") REFERENCES "public"."candidate_pairs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_pairs_unique_idx" ON "candidate_pairs" USING btree ("claim_a_id","claim_b_id");--> statement-breakpoint
CREATE INDEX "candidate_pairs_scope_idx" ON "candidate_pairs" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "claims_document_idx" ON "claims" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "claims_section_idx" ON "claims" USING btree ("section_id");--> statement-breakpoint
CREATE INDEX "claims_type_idx" ON "claims" USING btree ("claim_type");--> statement-breakpoint
CREATE INDEX "claims_embedding_idx" ON "claims" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "extraction_cache_key_idx" ON "extraction_cache" USING btree ("content_hash","model","prompt_version");--> statement-breakpoint
CREATE INDEX "findings_pair_idx" ON "findings" USING btree ("pair_id");--> statement-breakpoint
CREATE INDEX "findings_type_idx" ON "findings" USING btree ("conflict_type");