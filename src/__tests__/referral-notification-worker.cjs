(async () => {
  const { Client } = await import('pg');
  const connectionString = process.env.SUPABASE_TEST_DB_URL;
  if (!['localhost', '127.0.0.1'].includes(new URL(connectionString).hostname)) throw Error('Local database required');
  const db = new Client({ connectionString, statement_timeout: 10000 }); await db.connect();
  const phase = process.env.AUDIT_REFERRAL_PHASE;
  if (phase === 'settlement-committed') {
    await db.query('select public.settle_referral_purchase_rewards($1)', [process.env.AUDIT_REFERRAL_TRANSACTION]);
  } else if (phase === 'delivery-uncommitted') {
    await db.query('begin');
    await db.query('select public.deliver_referral_reward_notifications(100)');
  } else throw Error('Unknown checkpoint');
  process.send({ stage: phase });
  setInterval(() => {}, 1000);
})().catch(() => { process.send?.({ stage: 'failed' }); process.exit(1); });
