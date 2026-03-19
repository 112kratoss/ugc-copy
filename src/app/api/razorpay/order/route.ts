import { NextResponse } from 'next/server';
import Razorpay from 'razorpay';
import { createClient } from '@supabase/supabase-js';

import { PRICING_PLAN_MAP } from '@/lib/pricing';

// Initialize Supabase with User Auth Token
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;

export async function POST(req: Request) {
    try {
        // Initialize Razorpay inside to avoid build-time errors
        const razorpay = new Razorpay({
            key_id: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID as string,
            key_secret: process.env.RAZORPAY_KEY_SECRET as string,
        });

        const { planId, userId } = await req.json();

        if (!planId || !userId) {
            return NextResponse.json({ error: 'Missing planId or userId' }, { status: 400 });
        }

        const plan = PRICING_PLAN_MAP[planId as keyof typeof PRICING_PLAN_MAP];
        if (!plan) {
            return NextResponse.json({ error: 'Invalid planId' }, { status: 400 });
        }

        // Amount in subunits (paise). Razorpay needs INR for UPI.
        const amountInSubunits = plan.priceInr * 100;

        // Create order in Razorpay
        const shortUserId = userId.substring(0, 8);
        const orderOptions = {
            amount: amountInSubunits,
            currency: 'INR',
            receipt: `rcpt_${shortUserId}_${Date.now()}`,
        };

        const razorpayOrder = await razorpay.orders.create(orderOptions);

        if (!razorpayOrder || !razorpayOrder.id) {
            return NextResponse.json({ error: 'Failed to create Razorpay Order' }, { status: 500 });
        }

        // Insert transaction record in Supabase
        const supabase = createClient(supabaseUrl, supabaseAnonKey, {
            global: { headers: { Authorization: req.headers.get('Authorization')! } },
        });

        // Get authenticated user
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json(
                { error: 'Unauthorized: Please log in to purchase credits.' },
                { status: 401 }
            );
        }

        const { data: txnData, error: txnError } = await supabase
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

        // Return the Razorpay order ID to the client
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
