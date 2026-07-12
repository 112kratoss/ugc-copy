import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const migrationsDirectory = join(projectRoot, 'supabase', 'migrations');

function readHardeningMigration() {
  const migrationName = readdirSync(migrationsDirectory)
    .find((name) => name.endsWith('_harden_credit_mutations_and_reconcile_mobile_refunds.sql'));

  expect(migrationName, 'credit hardening migration is missing').toBeTruthy();
  return readFileSync(join(migrationsDirectory, migrationName as string), 'utf8');
}

function readAllMigrations() {
  return readdirSync(migrationsDirectory)
    .sort()
    .map((name) => readFileSync(join(migrationsDirectory, name), 'utf8'))
    .join('\n');
}

describe('credit mutation security boundary', () => {
  it('limits every balance mutation RPC to the service role', () => {
    const sql = readHardeningMigration();
    const signatures = [
      'add_credits(uuid, integer, uuid, text)',
      'deduct_credits(uuid, integer)',
      'refund_credits(uuid, integer)',
      'refund_generation(text)',
      'refund_ai_usage_event(uuid)',
      'reconcile_mobile_credit_refund(text, uuid, text, text, bigint, text)',
    ];

    for (const signature of signatures) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM anon`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM authenticated`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role`);
    }
  });

  it('keeps atomic generation start RPCs private to the service role', () => {
    const sql = readAllMigrations();
    const signatures = [
      'start_ai_usage_event(uuid, integer, text, text, text, text, text, text)',
      'start_generation(uuid, integer, text, text, text, integer, text, uuid, jsonb, text)',
      'attach_generation_provider_task(uuid, text)',
      'settle_generation_failed(text, timestamp with time zone)',
      'settle_generation_succeeded(text, text, timestamp with time zone, text, text, text, integer, text, timestamp with time zone, jsonb)',
    ];

    for (const signature of signatures) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM anon`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM authenticated`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role`);
    }
  });


  it('keeps transaction history readable but not writable by end users', () => {
    const sql = readHardeningMigration();

    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.transactions FROM anon');
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.transactions FROM authenticated');
    expect(sql).toContain('DROP POLICY IF EXISTS "Users can insert their own transactions." ON public.transactions');
    expect(sql).toContain('DROP POLICY IF EXISTS "Users can update their own transactions." ON public.transactions');
    expect(sql).toContain('CREATE POLICY "Users can view their own transactions."');
    expect(sql).toContain('REVOKE UPDATE ON TABLE public.profiles FROM anon');
    expect(sql).toContain('REVOKE UPDATE ON TABLE public.profiles FROM authenticated');
    expect(sql).toContain('GRANT UPDATE (username, display_name, bio, avatar_url, cover_url, website_url, twitter_handle, instagram_handle, tiktok_handle, location) ON TABLE public.profiles TO authenticated');
  });

  it('routes privileged mutations through service clients', () => {
    const razorpayOrder = readFileSync(join(projectRoot, 'src/app/api/razorpay/order/route.ts'), 'utf8');
    const razorpayVerify = readFileSync(join(projectRoot, 'src/app/api/razorpay/verify/route.ts'), 'utf8');
    const razorpayOrderAdapter = readFileSync(
      join(projectRoot, 'src/lib/razorpay-credit-order-route-adapter-service.ts'),
      'utf8',
    );
    const razorpayVerifyAdapter = readFileSync(
      join(projectRoot, 'src/lib/razorpay-credit-verify-route-adapter-service.ts'),
      'utf8',
    );
    const razorpayOrderService = readFileSync(join(projectRoot, 'src/lib/razorpay-credit-order-service.ts'), 'utf8');
    const razorpayVerifyService = readFileSync(join(projectRoot, 'src/lib/razorpay-credit-verify-service.ts'), 'utf8');
    const generate = readFileSync(join(projectRoot, 'src/app/api/generate/route.ts'), 'utf8');
    const generateImage = readFileSync(join(projectRoot, 'src/app/api/generate-image/route.ts'), 'utf8');
    const generateVideo = readFileSync(join(projectRoot, 'src/app/api/generate-video/route.ts'), 'utf8');
    const generationRouteAdapter = readFileSync(
      join(projectRoot, 'src/lib/generation-route-adapter-service.ts'),
      'utf8',
    );
    const motionStartService = readFileSync(join(projectRoot, 'src/lib/motion-generation-start-service.ts'), 'utf8');
    const motionStatusService = readFileSync(join(projectRoot, 'src/lib/motion-generation-status-service.ts'), 'utf8');
    const imageStartService = readFileSync(join(projectRoot, 'src/lib/image-generation-start-service.ts'), 'utf8');
    const imageStatusService = readFileSync(join(projectRoot, 'src/lib/image-generation-status-service.ts'), 'utf8');
    const videoStartService = readFileSync(join(projectRoot, 'src/lib/video-generation-start-service.ts'), 'utf8');
    const videoStatusService = readFileSync(join(projectRoot, 'src/lib/video-generation-status-service.ts'), 'utf8');
    const generationServices = readFileSync(join(projectRoot, 'src/lib/generation-services.ts'), 'utf8');

    expect(razorpayOrder).toContain('postRazorpayCreditOrderRouteResponse');
    expect(razorpayOrderAdapter).toMatch(/adminSupabase:\s*dependencies\.createServiceClient\(\)/);
    expect(razorpayOrderAdapter).toContain('createCreditRazorpayOrderForRoute');
    expect(razorpayOrderService).toMatch(/adminSupabase\s*\.from\('transactions'\)/);
    expect(razorpayVerify).toContain('postRazorpayCreditVerifyRouteResponse');
    expect(razorpayVerifyAdapter).toMatch(/createAdminSupabase:\s*\(\)\s*=>\s*dependencies\.createServiceClient\(\)/);
    expect(razorpayVerifyAdapter).toContain('verifyCreditRazorpayPaymentForRoute');
    expect(razorpayVerifyService).toContain("adminSupabase.rpc('add_credits'");
    expect(generate).toContain('postMotionGenerationForRoute');
    expect(generateImage).toContain('postImageGenerationForRoute');
    expect(generateVideo).toContain('postVideoGenerationForRoute');
    expect(generationRouteAdapter).toContain('createAdminSupabase: dependencies.createServiceClient');
    expect(motionStartService).toContain('startMotionGeneration');
    expect(motionStartService).toContain('creditSupabase: adminSupabase');
    expect(motionStatusService).toContain('settleGenerationFailed');
    expect(motionStatusService).toContain('settleGenerationSucceeded');
    expect(imageStartService).toContain('creditSupabase: adminSupabase');
    expect(imageStatusService).toContain('settleGenerationFailed');
    expect(videoStartService).toContain('creditSupabase: adminSupabase');
    expect(videoStatusService).toContain('settleGenerationFailed');
    expect(videoStatusService).toContain('settleGenerationSucceeded');
    expect(generationServices).toContain("templateContext ? 'start_template_generation' : 'start_generation'");
    expect(generationServices).toContain('supabase.rpc(rpcName, rpcArgs)');
    expect(generationServices).toContain("supabase.rpc('attach_generation_provider_task'");
    expect(generationServices).toContain("creditSupabase.rpc('deduct_credits'");
    expect(generationServices).toContain("creditSupabase.rpc('refund_credits'");
    expect(generationServices).toContain("creditSupabase.rpc('settle_generation_failed'");
    expect(generationServices).toContain("settlementSupabase.rpc('settle_generation_succeeded'");
  });
});
