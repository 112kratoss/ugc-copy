begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(13);
insert into auth.users(id,email,aud,role,is_anonymous,created_at)
values ('05000000-0000-4000-8000-000000000091','credit-event-audit@example.invalid','authenticated','authenticated',false,now());
update public.profiles set credits=1000,promotional_credits=0 where id='05000000-0000-4000-8000-000000000091';
insert into public.transactions(id,user_id,razorpay_order_id,amount,credits,status,credit_effect_applied)
values
('05000000-0000-4000-8000-000000000092','05000000-0000-4000-8000-000000000091','audit_credit_event_1',1000,500,'success',true),
('05000000-0000-4000-8000-000000000093','05000000-0000-4000-8000-000000000091','audit_credit_event_2',1000,500,'success',true);
set local role service_role;
select is(public.reconcile_credit_purchase_adjustment('05000000-0000-4000-8000-000000000092','razorpay','audit_credit_event',500,'reverse','audit')->>'status','partially_reversed','original refund applies');
select is(public.reconcile_credit_purchase_adjustment('05000000-0000-4000-8000-000000000092','razorpay','audit_credit_event',500,'reverse','audit')->>'status','duplicate_event','exact replay is a duplicate');
select is(public.reconcile_credit_purchase_adjustment('05000000-0000-4000-8000-000000000093','razorpay','audit_credit_event',500,'reverse','audit')->>'status','event_conflict','event cannot move to another transaction');
select is(public.reconcile_credit_purchase_adjustment('05000000-0000-4000-8000-000000000092','razorpay','audit_credit_event',250,'reverse','audit')->>'status','event_conflict','conflicting event cannot hide behind stale snapshot handling');
select is(public.reconcile_credit_purchase_adjustment('05000000-0000-4000-8000-000000000092','razorpay','audit_credit_event',1000,'reverse','audit')->>'status','event_conflict','event cannot change target');
select is(public.reconcile_credit_purchase_adjustment('05000000-0000-4000-8000-000000000092','razorpay','audit_credit_event',0,'restore','audit')->>'status','event_conflict','event cannot become a restoration');
select is(public.reconcile_razorpay_credit_purchase_adjustment('05000000-0000-4000-8000-000000000092','audit_credit_event','audit_conflicting_payment',1000,'reverse','audit')->>'status','event_conflict','Razorpay wrapper propagates event conflicts');
select is((select razorpay_payment_id from public.transactions where id='05000000-0000-4000-8000-000000000092'),null::text,'Razorpay wrapper does not bind payment on conflict');
select is((select credits from public.profiles where id='05000000-0000-4000-8000-000000000091'),750,'conflicts leave balance intact');
select is((select count(*)::integer from public.credit_purchase_adjustments where provider_event_id='audit_credit_event'),1,'conflicts leave original event intact');
select is((select credit_reversed_amount_subunits from public.transactions where id='05000000-0000-4000-8000-000000000093'),0::bigint,'other transaction remains untouched');
select is(public.reconcile_credit_purchase_adjustment('05000000-0000-4000-8000-000000000092','razorpay','audit_credit_restore',0,'restore','audit')->>'status','restored','distinct restore still works');
select is((select credits from public.profiles where id='05000000-0000-4000-8000-000000000091'),1000,'legitimate restoration restores balance');
select * from finish();
rollback;
