-- Production credit grant evidence probe. All fixtures and transitions roll back.
-- No payment provider calls occur.
begin;
set local lock_timeout='3s';
set local statement_timeout='20s';
create temporary table payment_audit_results(label text, passed boolean) on commit drop;
grant insert,select on payment_audit_results to authenticated,anon,service_role;
create function pg_temp.ok(value boolean,label text) returns void language plpgsql security invoker as $fn$
begin
 if value is distinct from true then raise exception 'Payment audit failed: %',label; end if;
 insert into pg_temp.payment_audit_results values(label,true);
end; $fn$;
create function pg_temp.is(actual anyelement,expected anyelement,label text) returns void language plpgsql security invoker as $fn$
begin perform pg_temp.ok(actual is not distinct from expected,label); end; $fn$;
create function pg_temp.throws_ok(statement text,code text,unused text,label text) returns void language plpgsql security invoker as $fn$
begin
 begin execute statement;
 exception when others then
   if sqlstate=code and (unused is null or sqlerrm=unused) then perform pg_temp.ok(true,label); return; end if;
   raise;
 end;
 raise exception 'Expected denied operation: %',label;
end; $fn$;
set local search_path=public,pg_temp;
grant execute on function pg_temp.ok(boolean,text), pg_temp.is(anyelement,anyelement,text), pg_temp.throws_ok(text,text,text,text) to authenticated,anon,service_role;

insert into auth.users(id,email,aud,role,is_anonymous,created_at) values('e8500001-0000-4000-8000-000000000001','payment-evidence-audit@example.invalid','authenticated','authenticated',false,now());
update public.profiles set credits=100,promotional_credits=0 where id='e8500001-0000-4000-8000-000000000001';
insert into public.transactions(id,user_id,razorpay_order_id,amount,credits,status,mobile_product_id,razorpay_payment_id) values('e8500002-0000-4000-8000-000000000001','e8500001-0000-4000-8000-000000000001','order_evidence_1',49900,500,'created',null,null);
insert into public.transactions(id,user_id,razorpay_order_id,amount,credits,status,mobile_product_id,razorpay_payment_id) values('e8500002-0000-4000-8000-000000000002','e8500001-0000-4000-8000-000000000001','order_evidence_2',49900,500,'created',null,null);
insert into public.transactions(id,user_id,razorpay_order_id,amount,credits,status,mobile_product_id,razorpay_payment_id) values('e8500002-0000-4000-8000-000000000003','e8500001-0000-4000-8000-000000000001','order_evidence_3',49900,500,'created',null,null);
insert into public.transactions(id,user_id,razorpay_order_id,amount,credits,status,mobile_product_id,razorpay_payment_id) values('e8500002-0000-4000-8000-000000000004','e8500001-0000-4000-8000-000000000001','order_evidence_4',49900,500,'created',null,null);
insert into public.transactions(id,user_id,razorpay_order_id,amount,credits,status,mobile_product_id,razorpay_payment_id) values('e8500002-0000-4000-8000-000000000005','e8500001-0000-4000-8000-000000000001','order_evidence_5',49900,500,'created','magicbooklet.credits.500',null);
insert into public.transactions(id,user_id,razorpay_order_id,amount,credits,status,mobile_product_id,razorpay_payment_id) values('e8500002-0000-4000-8000-000000000006','e8500001-0000-4000-8000-000000000001','order_evidence_6',49900,500,'created',null,'pay_bound');
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select pg_temp.is(public.add_credits('e8500001-0000-4000-8000-000000000001',null,'e8500002-0000-4000-8000-000000000001','pay_null_credits'),false,'null credit amount rejected');
select pg_temp.is((select credits from public.profiles where id='e8500001-0000-4000-8000-000000000001'),100,'null credit amount cannot change balance');
select pg_temp.is((select status from public.transactions where id='e8500002-0000-4000-8000-000000000001'),'created','null credit amount leaves purchase unsettled');
select pg_temp.is(public.add_credits('e8500001-0000-4000-8000-000000000001',500,'e8500002-0000-4000-8000-000000000002',null),false,'null payment ID rejected');
select pg_temp.is((select credits from public.profiles where id='e8500001-0000-4000-8000-000000000001'),100,'null payment ID cannot change balance');
select pg_temp.is((select status from public.transactions where id='e8500002-0000-4000-8000-000000000002'),'created','null payment ID leaves purchase unsettled');
select pg_temp.is(public.add_credits('e8500001-0000-4000-8000-000000000001',500,'e8500002-0000-4000-8000-000000000003',''),false,'empty payment ID rejected');
select pg_temp.is((select credits from public.profiles where id='e8500001-0000-4000-8000-000000000001'),100,'empty payment ID cannot change balance');
select pg_temp.is((select status from public.transactions where id='e8500002-0000-4000-8000-000000000003'),'created','empty payment ID leaves purchase unsettled');
select pg_temp.is(public.add_credits('e8500001-0000-4000-8000-000000000001',500,'e8500002-0000-4000-8000-000000000004','   '),false,'blank payment ID rejected');
select pg_temp.is((select credits from public.profiles where id='e8500001-0000-4000-8000-000000000001'),100,'blank payment ID cannot change balance');
select pg_temp.is((select status from public.transactions where id='e8500002-0000-4000-8000-000000000004'),'created','blank payment ID leaves purchase unsettled');
select pg_temp.is(public.add_credits('e8500001-0000-4000-8000-000000000001',500,'e8500002-0000-4000-8000-000000000005','pay_mobile'),false,'mobile purchase rejected');
select pg_temp.is((select credits from public.profiles where id='e8500001-0000-4000-8000-000000000001'),100,'mobile purchase cannot change balance');
select pg_temp.is((select status from public.transactions where id='e8500002-0000-4000-8000-000000000005'),'created','mobile purchase leaves purchase unsettled');
select pg_temp.is(public.add_credits('e8500001-0000-4000-8000-000000000001',500,'e8500002-0000-4000-8000-000000000006','pay_conflict'),false,'conflicting bound payment rejected');
select pg_temp.is((select credits from public.profiles where id='e8500001-0000-4000-8000-000000000001'),100,'conflicting bound payment cannot change balance');
select pg_temp.is((select status from public.transactions where id='e8500002-0000-4000-8000-000000000006'),'created','conflicting bound payment leaves purchase unsettled');
select pg_temp.is((select razorpay_payment_id from public.transactions where id='e8500002-0000-4000-8000-000000000006'),'pay_bound','conflict preserves original payment evidence');
select pg_temp.is(public.add_credits('e8500001-0000-4000-8000-000000000001',500,'e8500002-0000-4000-8000-000000000006','pay_bound'),true,'matching bound payment grants once');
select pg_temp.is((select credits from public.profiles where id='e8500001-0000-4000-8000-000000000001'),600,'matching evidence grants recorded credits');
select pg_temp.is(public.add_credits('e8500001-0000-4000-8000-000000000001',500,'e8500002-0000-4000-8000-000000000006','pay_bound'),false,'same payment replay is inert');
select pg_temp.is(public.add_credits('e8500001-0000-4000-8000-000000000001',500,'e8500002-0000-4000-8000-000000000006','pay_different'),false,'different payment replay is inert');
select pg_temp.is((select credits from public.profiles where id='e8500001-0000-4000-8000-000000000001'),600,'replays preserve balance');
select pg_temp.is(public.add_credits('e8500001-0000-4000-8000-000000000001',500,'e8500002-0000-4000-8000-000000000001','  pay_normalized  '),true,'valid payment normalizes outer spaces');
select pg_temp.is((select razorpay_payment_id from public.transactions where id='e8500002-0000-4000-8000-000000000001'),'pay_normalized','stored provider ID is canonical');
select pg_temp.throws_ok($q$select public.add_credits('e8500001-0000-4000-8000-000000000001',500,'e8500002-0000-4000-8000-000000000002','pay_normalized')$q$,'23505',null,'one payment cannot settle two transactions');
select pg_temp.is((select credits from public.profiles where id='e8500001-0000-4000-8000-000000000001'),1100,'duplicate payment failure rolls back balance');
select pg_temp.is((select status from public.transactions where id='e8500002-0000-4000-8000-000000000002'),'created','duplicate payment failure leaves purchase unsettled');
select pg_temp.is(public.add_credits('e8500001-0000-4000-8000-000000000001',500,'e8500002-0000-4000-8000-000000000002','pay_recovery'),true,'failed grant can recover with valid unique payment');
select pg_temp.is((select credits from public.profiles where id='e8500001-0000-4000-8000-000000000001'),1600,'valid recovery grants exactly once');
select pg_temp.is((public.reconcile_razorpay_credit_purchase_adjustment('e8500002-0000-4000-8000-000000000006','refund:evidence','pay_bound',49900,'reverse','Audit full refund')->>'status'),'reversed','verified refund reverses original grant');
select pg_temp.is((select credits from public.profiles where id='e8500001-0000-4000-8000-000000000001'),1100,'refund removes purchased credits once');
select pg_temp.is(public.add_credits('e8500001-0000-4000-8000-000000000001',500,'e8500002-0000-4000-8000-000000000006','pay_bound'),false,'capture replay cannot resurrect refunded purchase');
select pg_temp.is((select credits from public.profiles where id='e8500001-0000-4000-8000-000000000001'),1100,'late capture preserves refunded balance');
reset role;
set local role anon;
select pg_temp.throws_ok($q$select public.add_credits('e8500001-0000-4000-8000-000000000001',500,'e8500002-0000-4000-8000-000000000003','pay_client')$q$,'42501',null,'anon cannot call payment grant');
reset role;
set local role authenticated;
select pg_temp.throws_ok($q$select public.add_credits('e8500001-0000-4000-8000-000000000001',500,'e8500002-0000-4000-8000-000000000003','pay_client')$q$,'42501',null,'authenticated cannot call payment grant');
reset role;
select jsonb_build_object('passed',count(*),'checks',jsonb_agg(label order by label)) as payment_audit from pg_temp.payment_audit_results;
rollback;
