import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

export async function POST(req: Request) {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, userId } = await req.json();

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !userId) {
            return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
        }

        const keySecret = process.env.RAZORPAY_KEY_SECRET as string;

        // Verify signature
        const textToSign = `${razorpay_order_id}|${razorpay_payment_id}`;
        const generatedSignature = crypto
            .createHmac('sha256', keySecret)
            .update(textToSign)
            .digest('hex');

        if (generatedSignature !== razorpay_signature) {
            return NextResponse.json({ error: 'Invalid payment signature' }, { status: 400 });
        }

        // Authenticate with the shared user-scoped Supabase helper.
        const supabase = createUserClient(req);

        // Get authenticated user
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user || user.id !== userId) {
            return NextResponse.json(
                { error: 'Unauthorized' },
                { status: 401 }
            );
        }

        // Get the transaction record
        const { data: txn, error: txnError } = await supabase
            .from('transactions')
            .select('id, credits, status')
            .eq('razorpay_order_id', razorpay_order_id)
            .eq('user_id', user.id)
            .single();

        if (txnError || !txn) {
            console.error('Transaction fetch error:', txnError);
            return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
        }

        if (txn.status === 'success') {
            // Already processed
            return NextResponse.json({ success: true, alreadyProcessed: true });
        }

        // Credit mutation is service-role-only; ownership was established above.
        const adminSupabase = createServiceClient();
        const { data: rpcSuccess, error: rpcError } = await adminSupabase.rpc('add_credits', {
            p_user_id: user.id,
            p_credits: txn.credits,
            p_transaction_id: txn.id,
            p_payment_id: razorpay_payment_id,
        });

        if (rpcError || !rpcSuccess) {
            console.error('RPC add_credits error:', rpcError);
            return NextResponse.json({ error: 'Failed to assign credits' }, { status: 500 });
        }

        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        console.error('Razorpay Verify Error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Internal Server Error' },
            { status: 500 }
        );
    }
}
