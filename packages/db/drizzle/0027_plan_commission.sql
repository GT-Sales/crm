ALTER TABLE "app"."plans" ADD COLUMN "commission_type" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."plans" ADD COLUMN "commission_rate_bps" integer;--> statement-breakpoint
ALTER TABLE "app"."plans" ADD COLUMN "commission_minor" bigint;--> statement-breakpoint
ALTER TABLE "app"."plans" ADD CONSTRAINT "plans_commission_check" CHECK (("app"."plans"."commission_type" = 'none' and "app"."plans"."commission_rate_bps" is null and "app"."plans"."commission_minor" is null)
          or ("app"."plans"."commission_type" = 'percent' and "app"."plans"."commission_rate_bps" between 0 and 10000 and "app"."plans"."commission_minor" is null)
          or ("app"."plans"."commission_type" = 'fixed' and "app"."plans"."commission_minor" >= 0 and "app"."plans"."commission_rate_bps" is null));