import { NextResponse } from 'next/server';
import Razorpay from 'razorpay';

import { PRICING_PLAN_MAP } from '@/lib/pricing';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

export async function POST(req: Request) {
    try {
        const { planId } = await req.json();

        if (!planId) {
            return NextResponse.json({ error: 'Missing planId' }, { status: 400 });
        }

        const plan = PRICING_PLAN_MAP[planId as keyof typeof PRICING_PLAN_MAP];
        if (!plan) {
            return NextResponse.json({ error: 'Invalid planId' }, { status: 400 });
        }

        // Authenticate before creating an external order or privileged transaction row.
        const supabase = createUserClient(req);

        // Get authenticated user
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json(
                { error: 'Unauthorized: Please log in to purchase credits.' },
                { status: 401 }
            );
        }

        const amountInSubunits = plan.priceInr * 100;
        // Initialize Razorpay only after validation/authentication to keep rejected requests cheap.
        const razorpay = new Razorpay({
            key_id: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID as string,
            key_secret: process.env.RAZORPAY_KEY_SECRET as string,
        });

        const razorpayOrder = await razorpay.orders.create({
            amount: amountInSubunits,
            currency: 'INR',
            receipt: `rcpt_${user.id.substring(0, 8)}_${Date.now()}`,
        });

        if (!razorpayOrder?.id) {
            return NextResponse.json({ error: 'Failed to create Razorpay Order' }, { status: 500 });
        }

        const { data: txnData, error: txnError } = await createServiceClient()
            .from('transactions')
            .insert({
                user_id: user.id,
                razorpay_order_id: razorpayOrder.id,
                amount: amountInSubunits,
                credits: plan.credits,
                status: 'created',
            })
            .select('id')
            .single();

        if (txnError || !txnData) {
            console.error('Supabase transaction insert error:', txnError);
            return NextResponse.json({ error: 'Failed to record transaction' }, { status: 500 });
        }

        return NextResponse.json({
            orderId: razorpayOrder.id,
            amount: amountInSubunits,
            currency: 'INR',
        });
    } catch (error: unknown) {
        console.error('Razorpay Order Error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Internal Server Error' },
            { status: 500 }
        );
    }
}
